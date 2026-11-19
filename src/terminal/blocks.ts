import type { IBuffer, IDisposable, IEvent, IMarker } from "@xterm/xterm";

/*
 * Blocks: the output of a terminal, cut into one block per command using the
 * OSC 133 marks our shell integration prints (see docs/terminal.md).
 *
 *   ESC ] 133 ; A BEL         prompt starts
 *   ESC ] 133 ; B BEL         prompt ends, the user's input starts
 *   ESC ] 133 ; C BEL         the command line was accepted; output starts
 *   ESC ] 133 ; D ; <n> BEL   the command finished with exit status n
 *
 * The xterm buffer stays the source of truth: a block is a pair of markers
 * (`term.registerMarker`) on the rows where its output starts (C) and ends
 * (D), which xterm keeps pointing at the right rows as scrollback is
 * trimmed or reflowed. Blocks whose rows have left the scrollback are
 * dropped. `BlockTracker` only follows marks and keeps the list; drawing
 * the rows is `blockRender.ts`, the UI is `BlocksView`.
 */

export type PromptMark =
  | { kind: "A" | "B" | "C" }
  | { kind: "D"; exitCode: number | undefined };

/** Parses the payload of an OSC 133 sequence (what follows `133;`). */
export function parseOsc133(data: string): PromptMark | null {
  const [kind, ...params] = data.split(";");
  switch (kind) {
    case "A":
    case "B":
    case "C":
      return { kind };
    case "D": {
      const first = params[0];
      const code = first !== undefined && /^-?\d+$/.test(first) ? Number(first) : undefined;
      return { kind: "D", exitCode: code };
    }
    default:
      return null;
  }
}

/** What the tracker needs from an xterm `Terminal` (headless in tests). */
export type BlockTerminal = {
  readonly cols: number;
  readonly rows: number;
  readonly options: { readonly scrollback?: number };
  readonly buffer: {
    readonly active: IBuffer;
    readonly normal: IBuffer;
    readonly onBufferChange: IEvent<IBuffer>;
  };
  readonly parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): IDisposable;
    registerCsiHandler(
      id: { final: string; prefix?: string; intermediates?: string },
      callback: (params: (number | number[])[]) => boolean | Promise<boolean>,
    ): IDisposable;
  };
  readonly onWriteParsed: IEvent<void>;
  registerMarker(cursorYOffset?: number): IMarker | undefined;
};

export type Block = {
  readonly id: number;
  /** The command line, as sent from the input editor or read back from the prompt. */
  readonly command: string;
  /** Working directory when the command started. */
  readonly cwd: string | undefined;
  /** Git branch of `cwd` when it started, once looked up; `null` outside a repository. */
  branch: string | null | undefined;
  /** First row of output (where C was printed), or the first one left (see `truncated`). */
  start: IMarker;
  /** The beginning of the output was trimmed from the scrollback or erased. */
  truncated: boolean;
  /** Row the D mark was printed on; unset while running. */
  end: IMarker | undefined;
  /** Column of the D mark: its row is part of the output only if this is > 0. */
  endCol: number;
  readonly startedAt: number;
  endedAt: number | undefined;
  /** Unset while running, and when the shell did not report one. */
  exitCode: number | undefined;
  /** The scrollback was cleared while it ran (`clear`): dropped when it finishes. */
  cleared: boolean;
};

/**
 * - `pending`: no mark yet and not given up waiting.
 * - `present`: the shell prints marks.
 * - `absent`: no mark arrived in time; the shell has no integration.
 */
export type Integration = "pending" | "present" | "absent";

/** `prompt`: waiting for a command line. `running`: a command (or the shell's startup) owns the terminal. */
export type Phase = "prompt" | "running";

export type BlocksSnapshot = {
  readonly integration: Integration;
  readonly phase: Phase;
  /** A full-screen program (vim, less, htop) switched to the alternate screen. */
  readonly altScreen: boolean;
  /** Blocks still in the scrollback, oldest first. The last one may be running. */
  readonly blocks: readonly Block[];
};

export type BlockTrackerOptions = {
  /** The shell's working directory as last reported (OSC 7). */
  cwd: () => string | undefined;
  /** Looks up a directory's git branch (`null` outside a work tree). */
  branch?: (cwd: string) => Promise<string | null>;
  /** How long to wait for the first mark after output starts. */
  integrationTimeoutMs?: number;
  now?: () => number;
};

/** How long after the first output a shell without marks is taken to have no integration. */
const INTEGRATION_TIMEOUT_MS = 3000;
/** Commands remembered per pane for history and suggestions. */
const MAX_PANE_COMMANDS = 500;

export class BlockTracker {
  private readonly listeners = new Set<() => void>();
  private readonly outputListeners = new Set<() => void>();
  private readonly disposables: IDisposable[] = [];
  private readonly now: () => number;

  private integration: Integration = "pending";
  private integrationTimer: ReturnType<typeof setTimeout> | undefined;
  private phase: Phase = "running";
  private altScreen = false;
  private blocks: Block[] = [];
  private nextId = 1;
  private snap: BlocksSnapshot;

  /** Where the user's input starts on the current prompt (B). */
  private inputStart: { marker: IMarker; col: number } | undefined;
  /** The command line the input editor is about to send, for the next C. */
  private pendingCommand: string | undefined;
  /** Commands run in this terminal, oldest first. */
  private readonly commandList: string[] = [];

  constructor(
    private readonly term: BlockTerminal,
    private readonly options: BlockTrackerOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.snap = this.makeSnapshot();
    this.disposables.push(
      term.parser.registerOscHandler(133, (data) => {
        const mark = parseOsc133(data);
        if (mark) this.handleMark(mark);
        return true;
      }),
      // `ESC [ 3 J` erases the scrollback (`clear` sends it): the blocks go too.
      term.parser.registerCsiHandler({ final: "J" }, (params) => {
        if (params[0] === 3) this.clear();
        return false; // xterm still does the erasing
      }),
      term.buffer.onBufferChange((buffer) => {
        const alt = buffer.type === "alternate";
        if (alt === this.altScreen) return;
        this.altScreen = alt;
        this.changed();
      }),
      term.onWriteParsed(() => {
        if (this.integration === "pending" && this.integrationTimer === undefined) {
          this.integrationTimer = setTimeout(() => {
            if (this.integration !== "pending") return;
            this.integration = "absent";
            this.changed();
          }, options.integrationTimeoutMs ?? INTEGRATION_TIMEOUT_MS);
        }
        if (this.phase === "running") for (const listener of this.outputListeners) listener();
      }),
    );
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): BlocksSnapshot => this.snap;

  /** Called after xterm parses output while a command runs (to redraw it live). */
  onOutput(listener: () => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Commands run in this terminal, oldest first. */
  get commands(): readonly string[] {
    return this.commandList;
  }

  /** The buffer blocks live in (marks are never placed on the alternate screen). */
  get buffer(): IBuffer {
    return this.term.buffer.normal;
  }

  /** Remembers the command line about to be sent, so the block shows it as typed. */
  noteCommand(command: string): void {
    this.pendingCommand = command;
  }

  /** Forgets every block so far (⌃L, Clear, `clear`). A running command's block goes when it ends. */
  clear(): void {
    const running = this.runningBlock();
    for (const block of this.blocks) if (block !== running) disposeBlock(block);
    this.blocks = running ? [running] : [];
    if (running) running.cleared = true;
    this.changed();
  }

  dispose(): void {
    clearTimeout(this.integrationTimer);
    for (const disposable of this.disposables) disposable.dispose();
    for (const block of this.blocks) disposeBlock(block);
    this.blocks = [];
    this.inputStart?.marker.dispose();
    this.listeners.clear();
    this.outputListeners.clear();
  }

  private runningBlock(): Block | undefined {
    const last = this.blocks[this.blocks.length - 1];
    return last && !last.end ? last : undefined;
  }

  private handleMark(mark: PromptMark): void {
    // Marks from a program on the alternate screen (or a nested shell
    // inside one) have nowhere sensible to point.
    if (this.term.buffer.active.type !== "normal") return;
    if (this.integration !== "present") {
      this.integration = "present";
      clearTimeout(this.integrationTimer);
    }
    switch (mark.kind) {
      case "A":
        this.finishRunning(undefined);
        this.inputStart?.marker.dispose();
        this.inputStart = undefined;
        this.phase = "prompt";
        break;
      case "B": {
        const marker = this.term.registerMarker(0);
        this.inputStart?.marker.dispose();
        this.inputStart = marker && { marker, col: this.term.buffer.normal.cursorX };
        this.phase = "prompt";
        break;
      }
      case "C":
        // A second C for the same command (fish 4 prints its own marks too) is ignored.
        if (this.phase === "prompt") this.startCommand();
        break;
      case "D":
        this.finishRunning(mark.exitCode);
        this.phase = "prompt";
        break;
    }
    this.changed();
  }

  private startCommand(): void {
    this.finishRunning(undefined);
    const start = this.term.registerMarker(0);
    const command = (this.pendingCommand ?? this.commandFromPrompt()).trim();
    this.pendingCommand = undefined;
    this.inputStart?.marker.dispose();
    this.inputStart = undefined;
    this.phase = "running";
    if (!start) return;
    const cwd = this.options.cwd();
    const block: Block = {
      id: this.nextId++,
      command,
      cwd,
      branch: undefined,
      start,
      truncated: false,
      end: undefined,
      endCol: 0,
      startedAt: this.now(),
      endedAt: undefined,
      exitCode: undefined,
      cleared: false,
    };
    start.onDispose(() => this.schedulePrune());
    this.blocks.push(block);
    if (command) {
      const index = this.commandList.lastIndexOf(command);
      if (index !== -1) this.commandList.splice(index, 1);
      this.commandList.push(command);
      if (this.commandList.length > MAX_PANE_COMMANDS) this.commandList.shift();
    }
    if (cwd && this.options.branch) {
      this.options.branch(cwd).then(
        (branch) => {
          block.branch = branch;
          if (this.blocks.includes(block)) this.changed();
        },
        () => {
          block.branch = null;
        },
      );
    }
  }

  /** Ends the running block, if any. `exitCode` is unset when the command's end was not reported. */
  private finishRunning(exitCode: number | undefined): void {
    const block = this.runningBlock();
    if (!block) return;
    block.end = this.term.registerMarker(0) ?? block.start;
    block.end.onDispose(() => this.schedulePrune());
    block.endCol = this.term.buffer.normal.cursorX;
    block.endedAt = this.now();
    block.exitCode = exitCode;
    if (block.cleared) {
      disposeBlock(block);
      this.blocks = this.blocks.filter((other) => other !== block);
    }
  }

  /**
   * The command line as the shell echoed it, from B to where the output
   * starts. Used when it was typed into the terminal rather than the editor.
   */
  private commandFromPrompt(): string {
    const input = this.inputStart;
    if (!input || input.marker.line < 0) return "";
    const buffer = this.term.buffer.normal;
    const last = buffer.baseY + buffer.cursorY;
    let text = "";
    for (let row = input.marker.line; row < last; row++) {
      const line = buffer.getLine(row);
      if (!line) break;
      if (row > input.marker.line && !line.isWrapped) text += "\n";
      text += line.translateToString(true, row === input.marker.line ? input.col : 0);
    }
    return text;
  }

  private pruneQueued = false;

  private schedulePrune(): void {
    if (this.pruneQueued) return;
    this.pruneQueued = true;
    queueMicrotask(() => {
      this.pruneQueued = false;
      this.prune();
    });
  }

  /**
   * Markers are disposed when their row leaves the scrollback or is erased
   * (`ESC [ 2 J`). A finished block that lost either end is dropped. The
   * running block is re-anchored: at the top of the buffer if it is full
   * (the start was trimmed), else at the top of the screen (it was erased).
   */
  private prune(): void {
    const running = this.runningBlock();
    let reanchored = false;
    if (running?.start.isDisposed) {
      const buffer = this.term.buffer.normal;
      const full = buffer.length >= this.term.rows + (this.term.options.scrollback ?? 0);
      const target = full ? 0 : buffer.baseY;
      const marker = this.term.registerMarker(target - (buffer.baseY + buffer.cursorY));
      if (marker) {
        running.start = marker;
        running.truncated = true;
        reanchored = true;
        marker.onDispose(() => this.schedulePrune());
      }
    }
    const kept = this.blocks.filter((block) => {
      const gone = block.end !== undefined && (block.start.isDisposed || block.end.isDisposed);
      if (gone) disposeBlock(block);
      return !gone;
    });
    if (kept.length === this.blocks.length && !reanchored) return;
    this.blocks = kept;
    this.changed();
  }

  private makeSnapshot(): BlocksSnapshot {
    return {
      integration: this.integration,
      phase: this.phase,
      altScreen: this.altScreen,
      blocks: [...this.blocks],
    };
  }

  private changed(): void {
    this.snap = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
}

function disposeBlock(block: Block): void {
  block.start.dispose();
  block.end?.dispose();
}

/** The rows a block's output covers, `[from, to)`, in its buffer; `null` when they are gone. */
export function outputRows(block: Block, buffer: IBuffer): { from: number; to: number } | null {
  const from = block.start.line;
  if (from < 0) return null;
  let to: number;
  if (block.end) {
    if (block.end.line < 0) return null;
    to = block.end.line + (block.endCol > 0 ? 1 : 0);
  } else {
    // Running: up to the cursor's row, plus anything printed below it.
    to = buffer.baseY + buffer.cursorY + 1;
    for (let row = buffer.length - 1; row >= to; row--) {
      if (buffer.getLine(row)?.translateToString(true)) {
        to = row + 1;
        break;
      }
    }
  }
  return { from, to: Math.max(from, to) };
}
