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
 * Our scripts add `;aid=<id>` (the spec's application id) to every mark,
 * one id per shell, so marks from a shell nested inside it (`ssh host`)
 * can be told apart; see "Nested shells" below.
 *
 * The xterm buffer stays the source of truth: a block is a pair of markers
 * (`term.registerMarker`) on the rows where its output starts (C) and ends
 * (D), which xterm keeps pointing at the right rows as scrollback is
 * trimmed or reflowed. Blocks whose rows have left the scrollback are
 * dropped. `BlockTracker` only follows marks and keeps the list; drawing
 * the rows is `blockRender.ts`, the UI is `BlocksView`.
 *
 * Nested shells. A shell started inside a command (`ssh host` with our
 * integration on the remote, or a remote shell with its own OSC 133
 * script) prints marks of its own. The first aid seen is the root shell's;
 * an A with another aid (or none) while a root command runs enters the
 * nested scope: the outer block (`ssh host`) ends there and the nested
 * shell's commands become blocks of their own, flat in the same list,
 * tagged `nested` and with the nested shell's host and cwd (from OSC 7,
 * `noteCwd`), never the local ones. Any mark with the root aid leaves it:
 * a nested block still running ends with the root D's status, or else a
 * closing block for the outer command is added (what followed the last
 * prompt, e.g. "Connection to host closed."). A root shell without aids
 * (another terminal's integration) never enters the nested scope.
 */

export type PromptMark = (
  | { kind: "A" | "B" | "C" }
  | { kind: "D"; exitCode: number | undefined }
) & {
  /** The `aid=` parameter: which shell printed the mark. */
  aid?: string;
};

/** Parses the payload of an OSC 133 sequence (what follows `133;`). */
export function parseOsc133(data: string): PromptMark | null {
  const [kind, ...params] = data.split(";");
  const aidParam = params.find((param) => param.startsWith("aid="));
  const aid = aidParam ? aidParam.slice(4) || undefined : undefined;
  const withAid = <T extends object>(mark: T): T & { aid?: string } => (aid === undefined ? mark : { ...mark, aid });
  switch (kind) {
    case "A":
    case "B":
    case "C":
      return withAid({ kind });
    case "D": {
      const first = params[0];
      const code = first !== undefined && /^-?\d+$/.test(first) ? Number(first) : undefined;
      return withAid({ kind: "D" as const, exitCode: code });
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
  /** Host of `cwd` when it is not this machine (a nested shell over ssh). */
  readonly host: string | undefined;
  /** Run by a shell nested inside a root command (see "Nested shells"). */
  readonly nested: boolean;
  /** Git branch of `cwd` when it started, once looked up; `null` outside a repository. */
  branch: string | null | undefined;
  /** First row of output (where C was printed), or the first one left (see `truncated`). */
  start: IMarker;
  /** The beginning of the output was trimmed from the scrollback or erased. */
  truncated: boolean;
  /**
   * Sent from the input editor and no C seen yet: `start` is the row the
   * command line was typed on. Shells cannot mark every command (bash
   * prints no C for a line that is only a subshell), so the block exists
   * from the moment it is sent.
   */
  provisional: boolean;
  /** Start of the logical line the D mark was printed on; unset while running. */
  end: IMarker | undefined;
  /**
   * Where on that logical line D was printed, in cells. The line is part of
   * the output only up to there (bash prints its prompt right after output
   * that has no final newline). Counted in cells so it survives reflow.
   */
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
  /** The prompt belongs to a shell nested inside a root command (`ssh host`). */
  readonly nested: boolean;
  /**
   * Where the prompt is: for the root shell, `cwd` is unset here (use the
   * session's); for a nested shell, its last report, either part unset when
   * unknown.
   */
  readonly location: BlockLocation;
};

/** A working directory and, when it is not this machine, its host. */
export type BlockLocation = { readonly cwd?: string; readonly host?: string };

/**
 * Which commands a history entry belongs with: `""` for the root shell, a
 * host for a nested shell that reported one, `"nested"` otherwise.
 */
export type CommandScope = string;

/** The scope of a prompt or block: `nested` and where it is. */
export function scopeOf(nested: boolean, location: BlockLocation | undefined): CommandScope {
  if (!nested) return "";
  return location?.host ?? "nested";
}

export type BlockTrackerOptions = {
  /** The root shell's working directory as last reported (OSC 7 from this machine). */
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
  /** Commands run in this terminal, oldest first, with their scope. */
  private readonly commandList: { command: string; scope: CommandScope }[] = [];

  /** The root shell's aid: unset until the first mark, `null` if it had none. */
  private rootAid: string | null | undefined;
  private nested = false;
  /** The root command a nested shell runs inside (`ssh host`), for the closing block. */
  private outer: { command: string; cwd: string | undefined; startedAt: number } | undefined;
  /** The last OSC 7 since the current root command started (a nested shell's). */
  private innerLocation: BlockLocation | undefined;

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
        if (params[0] === 3 && term.buffer.active.type === "normal") this.clear();
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

  /** The root shell's commands in this terminal, oldest first. */
  get commands(): readonly string[] {
    return this.commandsFor("");
  }

  /** Commands run in `scope` in this terminal, oldest first. */
  commandsFor(scope: CommandScope): string[] {
    return this.commandList.filter((entry) => entry.scope === scope).map((entry) => entry.command);
  }

  /** The scope of the prompt: whose history applies to it. */
  get scope(): CommandScope {
    return scopeOf(this.nested, this.innerLocation);
  }

  /**
   * Records a working directory report (OSC 7). `host` is unset for this
   * machine. Root blocks take their directory from `options.cwd`; this is
   * where a nested shell's comes from.
   */
  noteCwd(location: BlockLocation): void {
    this.innerLocation = location;
    if (this.nested) this.changed();
  }

  /**
   * Leaves the nested scope without a closing block: the root shell is back
   * in the foreground but printed no mark we recognised (a root shell
   * without aids, or `exec zsh`).
   */
  resetScope(): void {
    if (!this.nested) return;
    if (this.runningBlock()) this.finishRunning(undefined);
    this.leaveNested();
    this.changed();
  }

  /** The buffer blocks live in (marks are never placed on the alternate screen). */
  get buffer(): IBuffer {
    return this.term.buffer.normal;
  }

  /**
   * Starts a block for a command line the input editor is sending. Returns
   * false (and the caller must not send it) unless the shell is at a prompt;
   * from now until the next prompt it is not, so a second Enter cannot type
   * into the running command.
   */
  submit(command: string): boolean {
    if (this.phase !== "prompt" || this.term.buffer.active.type !== "normal") return false;
    const start = this.term.registerMarker(0);
    if (!start) return false;
    this.inputStart?.marker.dispose();
    this.inputStart = undefined;
    this.phase = "running";
    if (!this.nested) this.innerLocation = undefined;
    this.addBlock(command, start, true);
    this.changed();
    return true;
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
    if (this.rootAid === undefined) this.rootAid = mark.aid ?? null;
    if (this.rootAid !== null) {
      if (this.nested && mark.aid === this.rootAid) {
        // The root shell is back: the nested one (and ssh) ended.
        this.closeNested(mark.kind === "D" ? mark.exitCode : undefined);
        if (mark.kind === "D") {
          this.phase = "prompt";
          this.changed();
          return;
        }
      } else if (!this.nested && mark.kind === "A" && mark.aid !== this.rootAid && this.runningBlock()) {
        this.enterNested();
      }
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
      case "C": {
        const running = this.runningBlock();
        if (running?.provisional) {
          // The command sent from the editor: its output starts here.
          const start = this.term.registerMarker(0);
          if (start) this.setStart(running, start);
          running.provisional = false;
        } else if (this.phase === "prompt") {
          this.startCommand();
        }
        // Otherwise a second C for the same command (fish 4 prints its own marks too).
        break;
      }
      case "D":
        this.finishRunning(mark.exitCode);
        this.phase = "prompt";
        break;
    }
    this.changed();
  }

  /** A command typed into the terminal itself started (C at a prompt). */
  private startCommand(): void {
    const start = this.term.registerMarker(0);
    const command = this.commandFromPrompt().trim();
    this.inputStart?.marker.dispose();
    this.inputStart = undefined;
    this.phase = "running";
    if (!this.nested) this.innerLocation = undefined;
    if (start) this.addBlock(command, start, false);
  }

  /** A nested shell's first prompt (A with a foreign aid) while root command runs. */
  private enterNested(): void {
    const running = this.runningBlock();
    if (!running) return;
    this.outer = { command: running.command, cwd: running.cwd, startedAt: running.startedAt };
    this.nested = true;
    // The A that follows ends the outer block, which holds the banner.
  }

  /** The root shell printed a mark: the nested shell is gone. */
  private closeNested(exitCode: number | undefined): void {
    if (this.runningBlock()) {
      // `exit` typed at the nested prompt, or the connection dropped mid-command.
      this.finishRunning(exitCode);
    } else if (this.outer) {
      this.closeOuter(exitCode);
    }
    this.leaveNested();
  }

  /**
   * Adds the closing block for the outer command (ended at a nested prompt,
   * e.g. by ⌃D): its output is what followed the last prompt line.
   */
  private closeOuter(exitCode: number | undefined): void {
    const outer = this.outer;
    if (!outer) return;
    const buffer = this.term.buffer.normal;
    const row = this.inputStart && this.inputStart.marker.line >= 0 ? this.inputStart.marker.line : buffer.baseY + buffer.cursorY;
    const start = this.markerAt(row);
    if (!start) return;
    this.addBlock(outer.command, start, true, {
      record: false,
      location: { cwd: outer.cwd },
      nested: false,
      startedAt: outer.startedAt,
    });
    this.finishRunning(exitCode);
  }

  private leaveNested(): void {
    this.nested = false;
    this.outer = undefined;
    this.innerLocation = undefined;
  }

  private addBlock(
    command: string,
    start: IMarker,
    provisional: boolean,
    overrides: { record?: boolean; location?: BlockLocation; nested?: boolean; startedAt?: number } = {},
  ): void {
    const nested = overrides.nested ?? this.nested;
    const location: BlockLocation =
      overrides.location ?? (nested ? (this.innerLocation ?? {}) : { cwd: this.options.cwd() });
    const { cwd, host } = location;
    const block: Block = {
      id: this.nextId++,
      command,
      cwd,
      host,
      nested,
      branch: undefined,
      start,
      truncated: false,
      provisional,
      end: undefined,
      endCol: 0,
      startedAt: overrides.startedAt ?? this.now(),
      endedAt: undefined,
      exitCode: undefined,
      cleared: false,
    };
    start.onDispose(() => this.schedulePrune());
    this.blocks.push(block);
    if (command.trim() && overrides.record !== false) {
      const scope = scopeOf(nested, location);
      const index = this.commandList.findIndex((entry) => entry.command === command && entry.scope === scope);
      if (index !== -1) this.commandList.splice(index, 1);
      this.commandList.push({ command, scope });
      if (this.commandList.length > MAX_PANE_COMMANDS) this.commandList.shift();
    }
    // Never looked up on this machine for a directory somewhere else.
    if (cwd && !host && this.options.branch) {
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

  private setStart(block: Block, start: IMarker): void {
    if (block.end !== block.start) block.start.dispose();
    block.start = start;
    start.onDispose(() => this.schedulePrune());
  }

  /** A marker on buffer row `line` (relative to the cursor, which is where xterm places them). */
  private markerAt(line: number): IMarker | undefined {
    const buffer = this.term.buffer.normal;
    return this.term.registerMarker(line - (buffer.baseY + buffer.cursorY));
  }

  /** Ends the running block, if any. `exitCode` is unset when the command's end was not reported. */
  private finishRunning(exitCode: number | undefined): void {
    const block = this.runningBlock();
    if (!block) return;
    // Output that trimmed the start and ended in the same write.
    if (block.start.isDisposed) this.reanchor(block);
    const buffer = this.term.buffer.normal;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (block.provisional) {
      // No C came: the output starts after the command line as echoed.
      let row = block.start.line;
      while (row >= 0 && buffer.getLine(row + 1)?.isWrapped) row++;
      const start = row >= 0 && row + 1 <= cursorRow ? this.markerAt(row + 1) : undefined;
      if (start) this.setStart(block, start);
      block.provisional = false;
    }
    // Anchored at the start of D's logical line, which reflow never merges away.
    let lineStart = cursorRow;
    while (lineStart > Math.max(0, block.start.line) && buffer.getLine(lineStart)?.isWrapped) lineStart--;
    block.end = this.markerAt(lineStart) ?? block.start;
    block.end.onDispose(() => this.schedulePrune());
    block.endCol = (cursorRow - lineStart) * this.term.cols + buffer.cursorX;
    block.endedAt = this.now();
    block.exitCode = exitCode;
    if (block.cleared) {
      disposeBlock(block);
      this.blocks = this.blocks.filter((other) => other !== block);
    }
  }

  /**
   * Re-anchors a block whose start marker was disposed: at the top of the
   * buffer if it is full (the start was trimmed), else at the top of the
   * screen (it was erased).
   */
  private reanchor(block: Block): boolean {
    const buffer = this.term.buffer.normal;
    const full = buffer.length >= this.term.rows + (this.term.options.scrollback ?? 0);
    const marker = this.markerAt(full ? 0 : buffer.baseY);
    if (!marker) return false;
    block.start = marker;
    block.truncated = true;
    block.provisional = false;
    marker.onDispose(() => this.schedulePrune());
    return true;
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
   * (`ESC [ 2 J`). A finished block that lost either end is dropped; the
   * running block is re-anchored.
   */
  private prune(): void {
    const running = this.runningBlock();
    const reanchored = running?.start.isDisposed === true && this.reanchor(running);
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
      nested: this.nested,
      location: this.nested ? (this.innerLocation ?? {}) : {},
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

/**
 * The rows a block's output covers, `[from, to)`, in its buffer; `null` when
 * they are gone. `lastCells`, if set, is how much of the last logical line
 * belongs to it.
 */
export function outputRows(
  block: Block,
  buffer: IBuffer,
): { from: number; to: number; lastCells?: number } | null {
  let from = block.start.line;
  if (from < 0) return null;
  if (block.end) {
    const end = block.end.line;
    if (end < 0) return null;
    if (block.endCol === 0) return { from, to: Math.max(from, end) };
    let to = end + 1;
    while (buffer.getLine(to)?.isWrapped) to++;
    return { from, to: Math.max(from, to), lastCells: block.endCol };
  }
  // Sent from the editor, no C yet: skip the command line itself.
  if (block.provisional) from += 1;
  // Running: up to the cursor's row, plus anything printed below it.
  let to = buffer.baseY + buffer.cursorY + 1;
  for (let row = buffer.length - 1; row >= to; row--) {
    if (buffer.getLine(row)?.translateToString(true)) {
      to = row + 1;
      break;
    }
  }
  return { from, to: Math.max(from, to) };
}
