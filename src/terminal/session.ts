import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IDisposable, type ITerminalOptions, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { effectiveSolid, oscColor } from "./solidBackground";
import { type Pty, type PtyExit, type PtyForeground, spawnPty } from "../ipc/pty";
import { type TerminalEnvironment, terminalEnvironmentForPane } from "../workspaces/settings";
import { copyText } from "../ipc/clipboard";
import { openExternal } from "../ipc/shell";
import { localHostname } from "../ipc/system";
import { type Block, BlockTracker, outputRows } from "./blocks";
import { blockDirectories } from "./pathTargets";
import { branchOf } from "./gitBranch";
import { registerFileLinks } from "./fileLinkProvider";
import { fitTerminal } from "./fit";
import { OSC_PATH, parseOsc7, parsePathReport } from "./osc";
import { isAppShortcut } from "../shortcuts";
import { type TerminalConfig, terminalConfig, terminalSettings } from "./settings";
import { TERMINAL_OPTIONS, terminalOptions } from "./theme";

export type SessionEvents = {
  /** The shell exited after running for a while (see `QUICK_EXIT_MS`). */
  onExit: (session: TerminalSession) => void;
  /** Output arrived while the terminal was off screen. Fires once per stretch off screen. */
  onBackgroundOutput: (session: TerminalSession) => void;
  /** The shell reported a new working directory (OSC 7). */
  onCwdChange: (session: TerminalSession, cwd: string) => void;
  /** A different program came to the foreground (or the shell got it back). */
  onForegroundChange: (session: TerminalSession) => void;
};

/**
 * How soon after output the foreground program is looked up again. Starting
 * or leaving a program (even a silent one: Enter echoes a newline) produces
 * output, so there is no need to poll while the terminal is quiet.
 */
const FOREGROUND_CHECK_MS = 250;
/**
 * While a program runs, it can hand the terminal to another without any
 * output (`sleep 1; yes > /dev/null`), so it is looked up this often too.
 */
const FOREGROUND_POLL_MS = 2000;

/**
 * A shell that ran for less than this probably failed to start. Its pane
 * stays open showing the error instead of vanishing (and, for a tab's last
 * pane, instead of looping through close-tab → new-tab → spawn).
 */
const QUICK_EXIT_MS = 1500;

/**
 * Clears the shell's command line: ⌃E (end of line) then ⌃U (kill to the
 * start). Works in zsh (emacs: end-of-line, kill-whole-line; viins: ⌃E
 * self-inserts and vi-kill-line removes it with the rest), bash (emacs:
 * end-of-line, unix-line-discard; vi insert: ⌃E self-inserts, ⌃U discards)
 * and fish (end-of-line, which also accepts an autosuggestion, then
 * backward-kill-line). Not in vi command mode or with rebound keys. In
 * fish an autosuggestion accepted by ⌃E ends up in the kill ring (⌃Y).
 * ⌃A ⌃K would avoid that but kills nothing in vi insert mode, where ⌃A
 * and ⌃K self-insert in zsh and bash.
 */
export const CLEAR_LINE = "\x05\x15";

/**
 * - `idle`: no shell yet (never shown); input is queued.
 * - `starting`: spawn requested; input is queued.
 * - `running`: input goes to the shell.
 * - `ended`: the shell exited or never started; input is dropped.
 */
type Phase = "idle" | "starting" | "running" | "ended";

type Input = { binary: boolean; data: string };

/**
 * One terminal: an xterm.js instance bound to a PTY.
 *
 * It owns a host element that outlives any React component. `attach` puts
 * the host on screen and `detach` takes it off without disturbing the shell
 * or scrollback; only `dispose` ends the session.
 */
export class TerminalSession {
  private readonly host = document.createElement("div");
  private readonly term = new Terminal({ ...TERMINAL_OPTIONS, ...terminalOptions(terminalConfig()) });
  private readonly search = new SearchAddon();
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private bellTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleFit());
  /** Commands and their output, from the shell's OSC 133 marks (blocks mode). */
  readonly blocks: BlockTracker;
  private webgl: WebglAddon | null = null;
  private fitFrame = 0;

  private phase: Phase = "idle";
  private disposed = false;
  private attached = false;
  private notifiedBackgroundOutput = false;
  /** Input typed while the shell was starting, in order. */
  private queuedInput: Input[] = [];

  /*
   * Flow-control accounting: every byte received must be acknowledged to the
   * backend exactly once, or it throttles the shell and delays its exit.
   * A byte is "settled" when xterm has parsed it, or when we know it never
   * will be (the session was disposed).
   */
  /** The PTY handle, once known. Kept after exit and disposal: late acknowledgements still go through it. */
  private pty: Pty | null = null;
  /** Bytes handed to xterm whose parse callback has not fired yet. */
  private unsettled = 0;
  /** Bytes settled before the PTY handle was known. */
  private pendingAck = 0;

  /** Last directory the shell reported; until then, where it was started. */
  private currentCwd: string | undefined;
  /** The file and folder links in output (their provider and listeners). */
  private readonly fileLinks: IDisposable;
  /** The root shell's `PATH`, from OSC 6973; unset until the first report. */
  private reportedPath: string | undefined;
  /**
   * Fallback when this machine's host name is unknown: the host named in
   * the first OSC 7, which normally comes from our own shell integration.
   */
  private firstHost: string | undefined;

  private lastForeground: PtyForeground | null = null;
  private readonly foregroundListeners = new Set<() => void>();
  /** Whether the terminal currently renders a solid background (see `effectiveSolid`). */
  private solid = false;
  /** A program set the background itself (OSC 11); xterm reports that color, not us. */
  private backgroundSet = false;
  private foregroundTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly paneId: string,
    private readonly events: SessionEvents,
    /** Directory to start the shell in; the home directory if unset or missing. */
    initialCwd?: string,
  ) {
    this.currentCwd = initialCwd;
    this.host.className = "terminal-host";

    this.term.loadAddon(this.search);
    this.solid = this.computeSolid(terminalConfig());
    this.host.classList.toggle("is-solid", this.solid);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Plain clicks are for selecting text and for the shell's mouse mode.
        if (event.metaKey || event.ctrlKey) openExternal(uri);
      }),
    );

    // Paths a shell over ssh prints are not files here.
    this.fileLinks = registerFileLinks(
      this.term,
      paneId,
      (row) => this.linkDirectories(row),
      () => !this.wantsMouse,
    );

    // Let app shortcuts through to the window handler untouched.
    this.term.attachCustomKeyEventHandler((event) => !isAppShortcut(event));

    this.term.onData((data) => {
      // What the user types (in either mode): typeahead is adopted only if typed (MID-36).
      this.blocks.noteInput(data);
      this.send({ binary: false, data });
    });
    // Reports that are bytes rather than text, e.g. legacy mouse encoding.
    this.term.onBinary((data) => this.send({ binary: true, data }));
    this.term.parser.registerOscHandler(7, (data) => {
      this.handleCwdReport(data);
      return true;
    });
    // Apps (codex) ask for the default background to blend against; a
    // transparent theme would answer black, so answer with the solid color.
    this.term.parser.registerOscHandler(OSC_PATH, (data) => {
      const report = parsePathReport(data);
      // A nested shell (ssh) reports its own, which is no use here.
      if (report && this.blocks.isRootReport(report.aid)) this.reportedPath = report.path;
      return true;
    });
    this.term.parser.registerOscHandler(11, (data) => this.answerBackgroundQuery(data));
    this.term.parser.registerOscHandler(111, () => {
      this.backgroundSet = false;
      return false;
    });
    this.term.buffer.onBufferChange(() => this.refreshSolid());
    this.blocks = new BlockTracker(this.term, { cwd: () => this.currentCwd, branch: branchOf });
    // Back at a prompt, the shell has the terminal again: look the foreground
    // up now rather than at the next poll, so the next command is not taken
    // for the program that just exited (full-pane programs, tab titles).
    let lastPhase = this.blocks.snapshot().phase;
    this.blocks.subscribe(() => {
      const { phase } = this.blocks.snapshot();
      if (phase === lastPhase) return;
      lastPhase = phase;
      if (phase !== "prompt" || this.disposed) return;
      clearTimeout(this.foregroundTimer);
      this.foregroundTimer = undefined;
      void this.foreground().catch(() => {});
    });
    this.term.onBell(() => this.ring());
    // Copy on select: only selections made with the mouse (the search addon
    // selects its matches too, and those must not reach the clipboard).
    this.host.addEventListener("mouseup", () => {
      if (!terminalSettings().copyOnSelect) return;
      // After xterm has finished the selection (a double click selects a word on release).
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        const text = this.term.getSelection();
        if (text) void copyText(text);
      }, 0);
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.phase === "running") this.pty?.resize(cols, rows);
    });
  }

  /** Applies changed settings to the live terminal (fonts, cursor, colors, scrollback). */
  applySettings(settings: TerminalConfig): void {
    if (this.disposed) return;
    this.solid = this.computeSolid(settings);
    // Assigning the theme drops colors a program set (OSC 11 included).
    this.backgroundSet = false;
    const next = terminalOptions(settings, this.solid);
    const current = this.term.options;
    const transparencyChanged = next.allowTransparency !== current.allowTransparency;
    const metricsChanged = next.fontFamily !== current.fontFamily || next.fontSize !== current.fontSize;
    for (const [key, value] of Object.entries(next) as [keyof ITerminalOptions, unknown][]) {
      if (key === "theme" || current[key] !== value) (this.term.options as Record<string, unknown>)[key] = value;
    }
    this.host.classList.toggle("is-solid", this.solid);
    // The WebGL renderer picks up transparency when it is created.
    if (transparencyChanged && this.webgl) {
      this.disableWebgl();
      this.enableWebgl();
    }
    if (metricsChanged) this.scheduleFit();
  }

  private computeSolid(settings: TerminalConfig): boolean {
    return effectiveSolid({
      terminalBackground: settings.terminalBackground,
      solidForFullscreen: settings.solidForFullscreen,
      solidBackgroundCommands: settings.solidBackgroundCommands,
      alternateScreen: this.term.buffer.active.type === "alternate",
      foregroundName: this.lastForeground?.name,
    });
  }

  /** Re-evaluates the effective background; touches xterm only when it flips. */
  private refreshSolid(): void {
    if (this.disposed) return;
    const config = terminalConfig();
    if (this.computeSolid(config) !== this.solid) this.applySettings(config);
  }

  /** Replies to `OSC 11 ; ?` with the solid color when the theme is transparent. */
  private answerBackgroundQuery(data: string): boolean {
    if (data !== "?") {
      this.backgroundSet = true;
      return false;
    }
    if (this.disposed || this.backgroundSet) return false;
    const background = this.term.options.theme?.background;
    // An opaque theme background is reported by xterm itself.
    if (background && !/^#[0-9a-f]{6}00$/i.test(background) && background !== "transparent") return false;
    const color = oscColor(terminalConfig().solidBackground);
    if (!color) return false;
    this.send({ binary: false, data: `\x1b]11;${color}\x1b\\` });
    return true;
  }

  /*
   * Search in the scrollback (the find bar in TerminalPane). Matches are
   * highlighted with decorations; results come through `onSearchResults`.
   */

  /** Finds the next (or previous) match of `query`; `incremental` keeps the current match if it still fits. */
  find(query: string, { backwards = false, incremental = false } = {}): boolean {
    if (!query) {
      this.search.clearDecorations();
      return false;
    }
    const { match, matchActive, accent } = terminalConfig();
    const options = {
      incremental,
      decorations: {
        matchBackground: match,
        matchOverviewRuler: accent,
        activeMatchBackground: matchActive,
        activeMatchColorOverviewRuler: accent,
      },
    };
    return backwards ? this.search.findPrevious(query, options) : this.search.findNext(query, options);
  }

  /** Removes search highlights. */
  clearSearch(): void {
    this.search.clearDecorations();
    this.term.clearSelection();
  }

  /** Reports `{ resultIndex, resultCount }` after each search (index -1 when none is active). */
  onSearchResults(listener: (results: { resultIndex: number; resultCount: number }) => void): () => void {
    const subscription = this.search.onDidChangeResults(listener);
    return () => subscription.dispose();
  }

  /**
   * The bell: a flash of the pane or a short tone, per the settings. A burst
   * of bells gives one flash: nothing is touched while one is showing.
   */
  private ring(): void {
    const { bell } = terminalSettings();
    if (bell === "visual") {
      if (this.bellTimer !== undefined || !this.attached) return;
      // The pane, not the host, which is invisible in blocks mode.
      const pane = this.host.closest<HTMLElement>("[data-pane-id]");
      if (!pane) return;
      pane.classList.add("is-ringing");
      this.bellTimer = setTimeout(() => {
        this.bellTimer = undefined;
        pane.classList.remove("is-ringing");
      }, 300);
    } else if (bell === "sound") {
      playBell();
    }
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /** The terminal's foreground program as last looked up; `null` before the shell runs. */
  get foregroundProgram(): PtyForeground | null {
    return this.lastForeground;
  }

  /** Calls `listener` when `foregroundProgram` changes; returns the unsubscribe. For `useSyncExternalStore`. */
  readonly subscribeForeground = (listener: () => void): (() => void) => {
    this.foregroundListeners.add(listener);
    return () => this.foregroundListeners.delete(listener);
  };

  /** Looks up the foreground program now. `null` if there is no running shell. */
  async foreground(): Promise<PtyForeground | null> {
    if (this.phase !== "running" || !this.pty) return null;
    const current = await this.pty.foreground();
    this.noteForeground(current);
    return current;
  }

  /** The shell's `PATH` as it last reported it (OSC 6973); `undefined` before the first report. */
  get shellPath(): string | undefined {
    return this.reportedPath;
  }

  /** The shell's working directory, as far as we know. */
  get cwd(): string | undefined {
    return this.currentCwd;
  }

  /** Shows the terminal inside `container`, starting the shell on first use. */
  attach(container: HTMLElement): void {
    if (this.disposed) return;
    container.appendChild(this.host);
    this.attached = true;
    this.notifiedBackgroundOutput = false;

    if (!this.term.element) this.term.open(this.host);
    this.enableWebgl();
    this.resizeObserver.observe(this.host);
    this.fitNow();
    this.start();
  }

  /** Takes the terminal off screen. The shell keeps running. */
  detach(): void {
    this.attached = false;
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.fitFrame);
    // Browsers cap live WebGL contexts, so only on-screen terminals hold one.
    this.disableWebgl();
    this.host.remove();
  }

  focus(): void {
    this.term.focus();
  }

  /** The selected text, or `""`. */
  get selection(): string {
    return this.term.getSelection();
  }

  /**
   * Whether the program in the terminal asked for mouse events. Right clicks
   * then belong to it rather than to the app's context menu.
   */
  get wantsMouse(): boolean {
    return this.term.modes.mouseTrackingMode !== "none";
  }

  /** Pastes text as the user would (bracketed if the program asked for it). */
  paste(text: string): void {
    if (text) this.term.paste(text);
  }

  selectAll(): void {
    this.term.selectAll();
  }

  /** Clears the scrollback and screen, keeping the line the cursor is on. */
  clear(): void {
    this.term.clear();
    this.blocks.clear();
  }

  /**
   * Runs a command line as if typed at the prompt and Enter pressed, if
   * the shell is at a prompt (returns whether it was sent). A multi-line
   * one must reach the shell as one command line: as a bracketed paste
   * when the shell enabled it, else with each newline quoted (⌃V ⌃J, which
   * readline and zle insert literally).
   */
  runCommand(command: string): boolean {
    // Text still on the shell's line (typed before ⌃A in classic mode, not
    // adopted, or a clear that did not work) would run in front of the
    // command. A right prompt also counts: that only costs a redundant clear.
    const leftover = this.blocks.hasLeftoverInput();
    if (!this.blocks.submit(command)) return false;
    const lines = command.split(/\r?\n/);
    const data =
      lines.length > 1 && this.term.modes.bracketedPasteMode
        ? `\x1b[200~${lines.join("\n")}\x1b[201~\r`
        : `${lines.join("\x16\n")}\r`;
    this.send({ binary: false, data: leftover ? CLEAR_LINE + data : data });
    return true;
  }

  /**
   * Moves text typed on the shell's own command line into the input editor
   * and clears the shell's line, so it neither stays hidden there nor runs
   * in front of the editor's next command: typeahead (keys typed while the
   * last command ran, which went to the hidden terminal and that the shell
   * echoes after its prompt) or a line started in classic mode before
   * switching to blocks. Checked now (the editor just appeared at a prompt)
   * and whenever output settles shortly after a prompt. Only text the user
   * typed is taken (see `typedPromptInput`). `adopt` gets the
   * text and returns whether it took it (only an empty editor does).
   * Returns the unsubscribe.
   */
  adoptPromptInput(adopt: (text: string) => boolean): () => void {
    const check = () => {
      const text = this.blocks.typedPromptInput();
      if (!text || !adopt(text)) return;
      this.blocks.inputWasTaken();
      this.send({ binary: false, data: CLEAR_LINE });
    };
    check();
    return this.blocks.onPromptInput(check);
  }

  /** The terminal's colors (blocks are drawn in the same palette). */
  get theme(): ITheme {
    return this.term.options.theme ?? {};
  }

  get cols(): number {
    return this.term.cols;
  }

  /** Sends text to the shell as if typed (used by the self-test). */
  input(data: string): void {
    this.send({ binary: false, data });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = "ended";
    clearTimeout(this.foregroundTimer);
    clearTimeout(this.copyTimer);
    clearTimeout(this.bellTimer);
    this.queuedInput = [];
    this.detach();
    // xterm drops its queued writes on dispose, so their callbacks never run.
    this.settle(this.unsettled);
    this.unsettled = 0;
    this.pty?.kill();
    this.blocks.dispose();
    this.fileLinks.dispose();
    this.term.dispose();
  }

  private start(): void {
    if (this.phase !== "idle") return;
    this.phase = "starting";

    const { shell, shellArgs, sshIntegration } = terminalSettings();
    // The workspace's environment variables, secrets and Python environment.
    terminalEnvironmentForPane(this.paneId)
      .catch((error: unknown): TerminalEnvironment => {
        console.warn("Could not read the workspace environment:", error);
        return { env: [], secrets: [], python: null };
      })
      .then(({ env, secrets, python }) => {
        // Closed while the environment was looked up: start nothing.
        if (this.disposed) return null;
        return spawnPty({
          cwd: this.currentCwd,
          shell: shell || undefined,
          shellArgs,
          sshIntegration,
          env,
          secrets,
          python,
          cols: this.term.cols,
          rows: this.term.rows,
          onData: (bytes) => this.receive(bytes),
          onExit: (exit) => this.handleExit(exit),
        });
      })
      .then(
        (pty) => {
          if (!pty) return;
          this.pty = pty;
          if (this.pendingAck) pty.ack(this.pendingAck);
          this.pendingAck = 0;

          if (this.disposed) {
            pty.kill();
            return;
          }
          // The shell may already have exited while the spawn was in flight.
          if (this.phase !== "starting") return;

          this.phase = "running";
          pty.resize(this.term.cols, this.term.rows);
          for (const input of this.queuedInput) this.write(pty, input);
          this.queuedInput = [];
        },
        (error) => {
          this.phase = "ended";
          this.queuedInput = [];
          this.report(`Could not start a shell: ${String(error)}`);
        },
      );
  }

  private send(input: Input): void {
    if (this.phase === "running" && this.pty) this.write(this.pty, input);
    // Before the shell runs (not yet shown, or starting) input waits for it.
    else if (this.phase === "idle" || this.phase === "starting") this.queuedInput.push(input);
    // Otherwise there is no shell to receive it.
  }

  private write(pty: Pty, input: Input): void {
    if (input.binary) pty.writeBinary(input.data);
    else pty.write(input.data);
  }

  private receive(bytes: Uint8Array): void {
    if (this.disposed) {
      // In flight when the session ended: discarded, but still accounted for.
      this.settle(bytes.length);
      return;
    }
    // Acknowledge only once xterm has parsed the chunk: that is what paces
    // the backend's reads to how fast the terminal can actually render.
    this.unsettled += bytes.length;
    this.term.write(bytes, () => {
      // `dispose` has already settled everything that was outstanding.
      if (this.disposed) return;
      this.unsettled -= bytes.length;
      this.settle(bytes.length);
    });
    this.scheduleForegroundCheck();
    if (!this.attached && !this.notifiedBackgroundOutput) {
      this.notifiedBackgroundOutput = true;
      this.events.onBackgroundOutput(this);
    }
  }

  private settle(bytes: number): void {
    if (!bytes) return;
    if (this.pty) this.pty.ack(bytes);
    else this.pendingAck += bytes;
  }

  /**
   * Whether an OSC 7 host is this machine. Reports from elsewhere (a shell
   * inside `ssh`) are not directories here and are ignored.
   */
  private isLocal(host: string): boolean {
    const local = localHostname();
    if (local) return host === "" || host === "localhost" || host === local || host === local.replace(/\.local$/, "");
    // Without the host name (outside Tauri), the first report is taken to be
    // this machine's: `localhost` too, so a later `file://box/…` is not.
    this.firstHost ??= host;
    return host === this.firstHost || ((host === "" || host === "localhost") && (this.firstHost === "" || this.firstHost === "localhost"));
  }

  private scheduleForegroundCheck(delay = FOREGROUND_CHECK_MS): void {
    if (this.foregroundTimer !== undefined || this.disposed) return;
    this.foregroundTimer = setTimeout(() => {
      this.foregroundTimer = undefined;
      void this.foreground().then((current) => {
        if (current && !current.isShell) this.scheduleForegroundCheck(FOREGROUND_POLL_MS);
      });
    }, delay);
  }

  private noteForeground(current: PtyForeground | null): void {
    if (this.disposed) return;
    // The root shell has the terminal again, so no nested shell (ssh) is
    // running, whatever marks were missed.
    if (current?.isShell) this.blocks.resetScope();
    const last = this.lastForeground;
    this.lastForeground = current;
    if (last?.pid !== current?.pid || last?.name !== current?.name) {
      this.refreshSolid();
      this.events.onForegroundChange(this);
      for (const listener of this.foregroundListeners) listener();
    }
  }

  /**
   * Where names printed on buffer row `row` are resolved: a block's output
   * where its command ran (see `blockDirectories`); other rows (prompts,
   * output from before the blocks known, e.g. cleared) where the next
   * command started, which is where the shell was when they were printed;
   * rows after the last block in the current directory. Null for a nested
   * shell's (ssh) output.
   */
  private linkDirectories(row: number): readonly (string | undefined)[] | null {
    const snapshot = this.blocks.snapshot();
    const buffer = this.term.buffer.active;
    let following: Block | undefined;
    if (buffer.type === "normal") {
      const { blocks } = snapshot;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const rows = outputRows(blocks[i], buffer);
        if (!rows || rows.to <= row) break;
        if (row >= rows.from) return blockDirectories(blocks, i, this.currentCwd, snapshot.nested);
        following = blocks[i];
      }
    }
    if (following) return following.host || following.nested ? null : [following.cwd ?? this.currentCwd];
    return snapshot.nested ? null : [this.currentCwd];
  }

  private handleCwdReport(data: string): void {
    const reported = parseOsc7(data);
    if (!reported) return;
    const local = this.isLocal(reported.host);
    // Every report, remote ones too, places a nested shell's blocks.
    this.blocks.noteCwd({ cwd: reported.path, host: local ? undefined : reported.host });
    // Only this machine's directories become the pane's (splits open there).
    if (!local || reported.path === this.currentCwd) return;
    this.currentCwd = reported.path;
    this.events.onCwdChange(this, reported.path);
  }

  private handleExit({ code, runtimeMs }: PtyExit): void {
    if (this.disposed) return;
    this.phase = "ended";
    clearTimeout(this.foregroundTimer);
    this.noteForeground(null);
    this.queuedInput = [];
    if (runtimeMs < QUICK_EXIT_MS) {
      this.report(`Shell exited immediately${code === null ? "" : ` (code ${code})`}.`);
      return;
    }
    this.events.onExit(this);
  }

  /** Prints a message from the app (not the shell) into the terminal. */
  private report(message: string): void {
    if (this.disposed) return;
    this.term.write(`\r\n\x1b[38;2;232;134;138m${message}\x1b[0m\r\n`);
  }

  private scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fitNow());
  }

  private fitNow(): void {
    // A hidden or collapsed host has no size to fit to.
    if (!this.attached || !this.host.clientWidth || !this.host.clientHeight) return;
    try {
      fitTerminal(this.term);
    } catch (error) {
      console.warn("Terminal fit failed:", error);
    }
  }

  private enableWebgl(): void {
    if (this.webgl) return;
    try {
      const webgl = new WebglAddon();
      // On context loss xterm falls back to its DOM renderer.
      webgl.onContextLoss(() => this.disableWebgl());
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch (error) {
      console.warn("WebGL terminal renderer unavailable, using DOM renderer:", error);
      this.webgl = null;
    }
  }

  private disableWebgl(): void {
    const webgl = this.webgl;
    this.webgl = null;
    try {
      webgl?.dispose();
    } catch (error) {
      console.warn("Disposing WebGL terminal renderer failed:", error);
    }
  }
}

let audio: AudioContext | null = null;
let lastBell = 0;

/** A short, soft tone. At most one per 100 ms, so a flood of BELs is not a buzz. */
function playBell(): void {
  const now = performance.now();
  if (now - lastBell < 100) return;
  lastBell = now;
  try {
    audio ??= new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.12);
  } catch (error) {
    console.warn("Bell sound failed:", error);
  }
}
