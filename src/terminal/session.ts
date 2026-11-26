import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IDisposable, type ITerminalOptions, type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  fallbackHostLabel,
  formatRemoteLocation,
  parseLocation,
} from "../files/location";
import {
  getConnection,
  hostLabelForLocation,
  markTerminalEnded,
  registerConnection,
  updateConnectionMeta,
} from "../ssh/connections";
import { effectiveSolid, oscColor } from "./solidBackground";
import { type Pty, type PtyExit, type PtyForeground, spawnPty } from "../ipc/pty";
import { type TerminalEnvironment, terminalEnvironmentForPane } from "../workspaces/settings";
import { copyText } from "../ipc/clipboard";
import { openExternal } from "../ipc/shell";
import { homeDirectory, localHostname } from "../ipc/system";
import { type Block, type BlockLocation, BlockTracker, type PromptMark, outputRows } from "./blocks";
import { commandPrograms } from "./fullPane";
import { blockDirectories } from "./pathTargets";
import { branchOf } from "./gitBranch";
import { registerFileLinks } from "./fileLinkProvider";
import { fitTerminal } from "./fit";
import { OSC_PATH, OSC_SSH, parseOsc7, parsePathReport, parseSshOsc } from "./osc";
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

/** State of an active first-hop SSH session inside this terminal. */
type ActiveRemote = {
  readonly id: string;
  label: string;
  /** True when the PTY itself was spawned directly as `ssh -t ...` (no local wrapper shell). */
  readonly direct: boolean;
  /**
   * Registration lifecycle with the Rust SSH manager:
   * - `pending`: `ssh_register_connection` IPC is in flight (fail-closed until resolved)
   * - `registered`: backend accepted registration (must call `markTerminalEnded` on exit)
   * - `direct`: spawned directly onto an already-registered connection (do not decrement refcount)
   */
  registration: "pending" | "registered" | "direct";
  /** First remote shell `aid=` observed for this first-hop connection. */
  aid: string | undefined;
  /** First OSC 7 hostname reported by this first-hop remote shell. */
  oscHost: string | undefined;
  /** True while a deeper (2nd-hop) nested shell is running inside this remote. */
  subNested: boolean;
  cwd: string | undefined;
  home: string | undefined;
  shell: string | undefined;
  path: string | undefined;
};

function generateSshToken(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One terminal: an xterm.js instance bound to a PTY.
 *
 * It owns a host element that outlives any React component. `attach` puts
 * the host on screen and `detach` takes it off without disturbing the shell
 * or scrollback; only `dispose` ends the session.
 */
export class TerminalSession {
  private readonly host = document.createElement("div");
  // App-wide settings here: field initializers may run before `paneId` is
  // set. The constructor then applies the pane's own config (its theme).
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

  /** Last local directory the shell reported; until then, where it was started (if local). */
  private localCwd: string | undefined;
  /** Initial `ssh://` location when this terminal was spawned directly onto a remote host. */
  private readonly directRemoteInitial: string | undefined;
  /** Per-PTY secret token authenticating local `OSC 6974;ssh=start/end` control messages. */
  private readonly sshToken = generateSshToken();
  /** Active managed SSH session (nested via `ssh <host>` or direct-SSH pane). */
  private activeRemote: ActiveRemote | null = null;
  /** The file and folder links in output (their provider and listeners). */
  private readonly fileLinks: IDisposable;
  /** The root local shell's `PATH`, from OSC 6973; unset until the first report. */
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
    /** Directory to start the shell in (local path or `ssh://<id>/<path>`); home if unset or missing. */
    initialCwd?: string,
  ) {
    const parsedInitial = initialCwd ? parseLocation(initialCwd) : null;
    if (parsedInitial?.kind === "remote") {
      const normalized = formatRemoteLocation(parsedInitial.remoteId, parsedInitial.path);
      this.directRemoteInitial = normalized;
      const existing = getConnection(parsedInitial.remoteId);
      this.activeRemote = {
        id: parsedInitial.remoteId,
        label: hostLabelForLocation(normalized) ?? fallbackHostLabel(parsedInitial.remoteId),
        direct: true,
        registration: "direct",
        aid: undefined,
        oscHost: undefined,
        subNested: false,
        cwd: parsedInitial.path,
        home: existing?.remoteHome ?? undefined,
        shell: existing?.remoteShell ?? undefined,
        path: undefined,
      };
    } else {
      this.localCwd = initialCwd;
    }
    this.host.className = "terminal-host";

    this.term.loadAddon(this.search);
    const config = terminalConfig(this.paneId);
    this.solid = this.computeSolid(config);
    this.term.options.theme = terminalOptions(config, this.solid).theme;
    this.host.classList.toggle("is-solid", this.solid);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Plain clicks are for selecting text and for the shell's mouse mode.
        if (event.metaKey || event.ctrlKey) openExternal(uri);
      }),
    );

    // Clickable files and folders in output (local and tracked SSH remotes).
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
    this.term.parser.registerOscHandler(OSC_SSH, (data) => {
      this.handleSshOsc(data);
      return true;
    });
    // Track `PATH` for both the local root shell and a tracked first-hop SSH shell.
    this.term.parser.registerOscHandler(OSC_PATH, (data) => {
      const report = parsePathReport(data);
      if (report) this.handlePathReport(report.path, report.aid);
      return true;
    });
    // Apps (codex) ask for the default background to blend against; a
    // transparent theme would answer black, so answer with the solid color.
    this.term.parser.registerOscHandler(11, (data) => this.answerBackgroundQuery(data));
    this.term.parser.registerOscHandler(111, () => {
      this.backgroundSet = false;
      return false;
    });
    this.term.buffer.onBufferChange(() => this.refreshSolid());
    this.blocks = new BlockTracker(this.term, {
      cwd: () => this.localCwd,
      rootLocation: this.activeRemote?.direct ? () => this.directRootLocation() : undefined,
      onMark: (mark, nested) => this.handleBlockMark(mark, nested),
      branch: branchOf,
    });
    // Back at a prompt, the shell has the terminal again: look the foreground
    // up now rather than at the next poll, so the next command is not taken
    // for the program that just exited (full-pane programs, tab titles).
    let lastPhase = this.blocks.snapshot().phase;
    let lastRunningCmd = this.blocks.runningCommand();
    this.blocks.subscribe(() => {
      const { phase } = this.blocks.snapshot();
      const runningCmd = this.blocks.runningCommand();
      const phaseChanged = phase !== lastPhase;
      const cmdChanged = runningCmd !== lastRunningCmd;
      lastPhase = phase;
      lastRunningCmd = runningCmd;
      if (this.activeRemote && (phaseChanged || cmdChanged) && !this.disposed) {
        this.notifyEffectiveForeground();
      }
      if (!phaseChanged || phase !== "prompt" || this.disposed) return;
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
    for (const listener of this.themeListeners) listener();
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
      foregroundName: this.effectiveForeground?.name,
    });
  }

  /** Re-evaluates the effective background; touches xterm only when it flips. */
  private refreshSolid(): void {
    if (this.disposed) return;
    const config = terminalConfig(this.paneId);
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
    const color = oscColor(terminalConfig(this.paneId).solidBackground);
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
    const { match, matchActive, accent } = terminalConfig(this.paneId);
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

  /** The terminal's raw OS foreground program as last looked up; `null` before the shell runs. */
  get foregroundProgram(): PtyForeground | null {
    return this.lastForeground;
  }

  /**
   * Effective foreground program: on a tracked SSH connection, derives the
   * remote shell/program from OSC 133 marks so tab titles, solid background,
   * and full-pane mode reflect what runs on the remote instead of always `"ssh"`.
   */
  get effectiveForeground(): PtyForeground | null {
    const remote = this.trackedRemote();
    if (remote && this.blocks) {
      const snap = this.blocks.snapshot();
      if (snap.integration === "present") {
        if (snap.phase === "prompt") {
          return {
            pid: this.lastForeground?.pid ?? 0,
            name: remote.shell || "ssh",
            isShell: true,
          };
        }
        const cmd = this.blocks.runningCommand();
        const prog = cmd ? commandPrograms(cmd)[0] : undefined;
        if (prog) {
          return {
            pid: this.lastForeground?.pid ?? 0,
            name: prog,
            isShell: false,
          };
        }
      }
    }
    return this.lastForeground;
  }

  /** Calls `listener` when `foregroundProgram` or remote command state changes; returns the unsubscribe. */
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

  /** The active shell's `PATH` as last reported (OSC 6973); `undefined` if unknown or in an untracked nested shell. */
  get shellPath(): string | undefined {
    if (this.activeRemote) {
      const tracked = this.trackedRemote();
      return tracked ? tracked.path : undefined;
    }
    return this.blocks.snapshot().nested ? undefined : this.reportedPath;
  }

  /** Managed SSH remote id currently active in this terminal (`null` when local, pending registration, or in a 2nd-hop shell). */
  get remoteId(): string | null {
    return this.trackedRemote()?.id ?? null;
  }

  /** Friendly host label for the active managed SSH connection, or `null` when local/untracked. */
  get remoteLabel(): string | null {
    return this.trackedRemote()?.label ?? null;
  }

  /** Whether the terminal is inside an untracked nested shell (2nd-hop SSH, pending registration, `docker exec`, or unwrapped `ssh`). */
  get isUntrackedNested(): boolean {
    if (this.activeRemote) return this.activeRemote.subNested || this.activeRemote.registration === "pending";
    return this.blocks.snapshot().nested;
  }

  /** Home directory matching the active shell's host (`ssh://<id><remoteHome>` when remote, else local home). */
  get shellHome(): string | undefined {
    if (this.activeRemote) {
      const remote = this.trackedRemote();
      if (!remote) return undefined;
      const h = remote.home ?? getConnection(remote.id)?.remoteHome ?? undefined;
      return h ? formatRemoteLocation(remote.id, h) : undefined;
    }
    return homeDirectory();
  }

  /**
   * The shell's working directory (`ssh://<id>/<path>` on a tracked SSH remote,
   * or local POSIX path). Never falls back to `localCwd` while on a remote host.
   */
  get cwd(): string | undefined {
    if (this.activeRemote) {
      const remote = this.trackedRemote();
      if (!remote) return undefined;
      if (remote.cwd) return formatRemoteLocation(remote.id, remote.cwd);
      if (remote.direct) return this.directRemoteInitial;
      return undefined;
    }
    return this.localCwd;
  }

  private trackedRemote(): ActiveRemote | null {
    const remote = this.activeRemote;
    if (!remote || remote.subNested || remote.registration === "pending") return null;
    return remote;
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

  private readonly themeListeners = new Set<() => void>();

  /** Calls `listener` when the session's colors change (its pane kind may have a theme of its own). Returns an unsubscribe function. */
  onThemeChange = (listener: () => void): (() => void) => {
    this.themeListeners.add(listener);
    return () => this.themeListeners.delete(listener);
  };

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
    if (this.activeRemote?.registration === "registered") markTerminalEnded(this.activeRemote.id);
    this.activeRemote = null;
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
          cwd: this.directRemoteInitial ?? this.localCwd,
          shell: shell || undefined,
          shellArgs,
          sshIntegration,
          sshToken: this.sshToken,
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
    // The local root shell has the terminal again, so no nested shell (ssh) is
    // running, whatever marks were missed (never applies to direct-SSH panes).
    if (current?.isShell && !this.activeRemote?.direct) {
      this.blocks.resetScope();
      if (this.activeRemote) this.endActiveRemote();
    }
    const last = this.lastForeground;
    this.lastForeground = current;
    if (last?.pid !== current?.pid || last?.name !== current?.name) {
      this.notifyEffectiveForeground();
    }
  }

  private notifyEffectiveForeground(): void {
    this.refreshSolid();
    this.events.onForegroundChange(this);
    for (const listener of this.foregroundListeners) listener();
  }

  private directRootLocation(): BlockLocation | undefined {
    const remote = this.activeRemote;
    if (!remote?.direct) return undefined;
    return {
      cwd: remote.cwd,
      host: remote.label,
      remoteId: remote.id,
    };
  }

  private endActiveRemote(): void {
    const ended = this.activeRemote;
    if (!ended || ended.direct) return;
    this.activeRemote = null;
    if (ended.registration === "registered") markTerminalEnded(ended.id);
    this.notifyEffectiveForeground();
    if (this.localCwd) this.events.onCwdChange(this, this.localCwd);
  }

  private handleBlockMark(mark: PromptMark, nested: boolean): void {
    const remote = this.activeRemote;
    if (!remote) return;
    const prevSub = remote.subNested;
    if (remote.direct) {
      if (!nested) {
        if (mark.aid && !remote.aid) remote.aid = mark.aid;
        remote.subNested = false;
      } else {
        remote.subNested = true;
      }
      if (remote.subNested !== prevSub) {
        if (remote.subNested && this.blocks.snapshot().location.remoteId) {
          this.blocks.noteCwd({});
        }
        this.notifyEffectiveForeground();
      }
      return;
    }
    // Nested SSH inside a local root shell.
    if (!nested && mark.aid !== undefined && mark.aid === this.blocks.rootShellAid) {
      // Local root shell printed a mark even if OSC 6974;ssh=end was missed.
      this.endActiveRemote();
      return;
    }
    if (nested) {
      if (remote.aid === undefined && mark.aid) {
        remote.aid = mark.aid;
        remote.subNested = false;
      } else if (remote.aid !== undefined) {
        if (mark.aid !== undefined) {
          remote.subNested = mark.aid !== remote.aid;
        } else if (!remote.subNested && mark.kind === "A" && this.blocks.runningCommand() !== undefined) {
          // A 2nd-hop nested shell without `aid=` printed a prompt while a 1st-hop command ran.
          remote.subNested = true;
        }
      }
      if (remote.subNested !== prevSub) {
        if (remote.subNested) {
          // Clear hop1's remoteId/cwd if hop2 didn't already replace it with its own OSC 7.
          if (this.blocks.snapshot().location.remoteId) this.blocks.noteCwd({});
        } else if (remote.registration === "registered") {
          this.blocks.noteCwd({ cwd: remote.cwd, host: remote.label, remoteId: remote.id });
        } else {
          this.blocks.noteCwd({ cwd: remote.cwd, host: remote.label });
        }
        this.notifyEffectiveForeground();
      }
    }
  }

  private handleSshOsc(data: string): void {
    const event = parseSshOsc(data);
    if (!event) return;
    if (event.kind === "start") {
      if (event.token !== this.sshToken || this.activeRemote?.direct) return;
      if (this.activeRemote?.registration === "registered") markTerminalEnded(this.activeRemote.id);
      const existing = getConnection(event.id);
      const remoteObj: ActiveRemote = {
        id: event.id,
        label: event.label,
        direct: false,
        registration: "pending",
        aid: undefined,
        oscHost: undefined,
        subNested: false,
        cwd: undefined,
        home: existing?.remoteHome ?? undefined,
        shell: existing?.remoteShell ?? undefined,
        path: undefined,
      };
      this.activeRemote = remoteObj;
      void registerConnection({
        id: event.id,
        label: event.label,
        host: event.host,
        user: event.user,
        port: event.port,
        controlPath: event.controlPath,
        ownedSocket: event.ownedSocket,
        sshArgs: event.sshArgs,
      }).then(
        (info) => {
          if (this.disposed || this.activeRemote !== remoteObj) {
            // Session ended or moved on before registration resolved: release the backend refcount.
            markTerminalEnded(info.id);
            return;
          }
          remoteObj.registration = "registered";
          // Replay any `meta=1` observed while registration was pending, and pull server-discovered metadata.
          if (remoteObj.home || remoteObj.shell) {
            updateConnectionMeta(info.id, { remoteHome: remoteObj.home, remoteShell: remoteObj.shell });
          }
          if (info.remoteHome && !remoteObj.home) remoteObj.home = info.remoteHome;
          if (info.remoteShell && !remoteObj.shell) remoteObj.shell = info.remoteShell;
          if (remoteObj.cwd && !remoteObj.subNested) {
            this.blocks.noteCwd({ cwd: remoteObj.cwd, host: remoteObj.label, remoteId: remoteObj.id });
            this.events.onCwdChange(this, formatRemoteLocation(remoteObj.id, remoteObj.cwd));
          }
          this.notifyEffectiveForeground();
        },
        (error) => {
          console.warn("Could not register SSH connection:", error);
          if (this.disposed || this.activeRemote !== remoteObj) return;
          // Fail closed: downgrade to an untracked nested session without affecting other panes.
          this.activeRemote = null;
          if (this.blocks.snapshot().nested) {
            this.blocks.noteCwd({ cwd: remoteObj.cwd, host: remoteObj.label });
          }
          this.notifyEffectiveForeground();
        },
      );
      this.notifyEffectiveForeground();
      return;
    }
    if (event.kind === "end") {
      if (event.token !== this.sshToken) return;
      if (this.activeRemote && !this.activeRemote.direct && this.activeRemote.id === event.id) {
        this.endActiveRemote();
      }
      return;
    }
    // `meta=1` (home & shell): applies to an active first-hop remote shell (buffered if registration is pending).
    const remote = this.activeRemote;
    if (!remote || remote.subNested) return;
    if (!remote.direct && event.aid !== undefined && event.aid === this.blocks.rootShellAid) return;
    if (remote.aid !== undefined && event.aid !== undefined && event.aid !== remote.aid) return;
    if (event.aid && remote.aid === undefined) remote.aid = event.aid;
    if (event.home) remote.home = event.home;
    if (event.shell) remote.shell = event.shell;
    if (remote.registration !== "pending") {
      updateConnectionMeta(remote.id, { remoteHome: event.home, remoteShell: event.shell });
    }
    this.notifyEffectiveForeground();
  }

  private handlePathReport(path: string, aid: string | undefined): void {
    const remote = this.activeRemote;
    if (remote) {
      if (remote.subNested) return;
      if (remote.direct) {
        if (this.blocks.isRootReport(aid)) remote.path = path;
      } else if (aid !== this.blocks.rootShellAid && (remote.aid === undefined || aid === remote.aid)) {
        if (aid && remote.aid === undefined) remote.aid = aid;
        remote.path = path;
      }
      return;
    }
    if (this.blocks.isRootReport(aid)) this.reportedPath = path;
  }

  /**
   * Where names printed on buffer row `row` are resolved: a block's output
   * where its command ran (see `blockDirectories`); other rows (prompts,
   * output from before the blocks known, e.g. cleared) where the next
   * command started, which is where the shell was when they were printed;
   * rows after the last block in the current directory. Null for an
   * untracked nested shell's output or before a remote cwd is known.
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
        if (row >= rows.from) return blockDirectories(blocks, i, this.cwd, this.isUntrackedNested);
        following = blocks[i];
      }
    }
    if (following) {
      if (following.remoteId) return following.cwd ? [formatRemoteLocation(following.remoteId, following.cwd)] : null;
      return following.host || following.nested ? null : [following.cwd ?? this.localCwd];
    }
    if (this.isUntrackedNested) return null;
    if (this.activeRemote && !this.cwd) return null;
    return [this.cwd];
  }

  private handleCwdReport(data: string): void {
    const reported = parseOsc7(data);
    if (!reported) return;
    const remote = this.activeRemote;
    if (remote) {
      const snap = this.blocks.snapshot();
      const foreignRunningHost =
        remote.aid !== undefined &&
        snap.phase === "running" &&
        remote.oscHost !== undefined &&
        reported.host !== remote.oscHost;
      if (remote.subNested || foreignRunningHost) {
        this.blocks.noteCwd({ cwd: reported.path, host: reported.host || undefined });
        return;
      }
      remote.oscHost ??= reported.host;
      const changed = remote.cwd !== reported.path;
      remote.cwd = reported.path;
      if (remote.registration === "pending") {
        this.blocks.noteCwd({ cwd: reported.path, host: remote.label });
        return;
      }
      this.blocks.noteCwd({ cwd: reported.path, host: remote.label, remoteId: remote.id });
      if (changed) this.events.onCwdChange(this, formatRemoteLocation(remote.id, reported.path));
      return;
    }
    const local = this.isLocal(reported.host);
    // Every report, remote ones too, places a nested shell's blocks.
    this.blocks.noteCwd({ cwd: reported.path, host: local ? undefined : reported.host });
    // Only this machine's directories become the pane's (splits open there).
    if (!local || reported.path === this.localCwd) return;
    this.localCwd = reported.path;
    this.events.onCwdChange(this, reported.path);
  }

  private handleExit({ code, runtimeMs }: PtyExit): void {
    if (this.disposed) return;
    this.phase = "ended";
    if (this.activeRemote?.registration === "registered") markTerminalEnded(this.activeRemote.id);
    this.activeRemote = null;
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
