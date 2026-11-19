import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Pty, type PtyExit, type PtyForeground, spawnPty } from "../ipc/pty";
import { openExternal } from "../ipc/shell";
import { localHostname } from "../ipc/system";
import { registerFileLinks } from "./fileLinkProvider";
import { parseOsc7 } from "./osc";
import { isAppShortcut } from "../shortcuts";
import { TERMINAL_OPTIONS } from "./theme";

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
 * - `idle`: no shell yet (never shown).
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
  private readonly term = new Terminal(TERMINAL_OPTIONS);
  private readonly fit = new FitAddon();
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleFit());
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
  /**
   * Fallback when this machine's host name is unknown: the host named in
   * the first OSC 7, which normally comes from our own shell integration.
   */
  private firstHost: string | undefined;

  private lastForeground: PtyForeground | null = null;
  private foregroundTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly paneId: string,
    private readonly events: SessionEvents,
    /** Directory to start the shell in; the home directory if unset or missing. */
    initialCwd?: string,
  ) {
    this.currentCwd = initialCwd;
    this.host.className = "terminal-host";

    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Plain clicks are for selecting text and for the shell's mouse mode.
        if (event.metaKey || event.ctrlKey) openExternal(uri);
      }),
    );

    registerFileLinks(this.term, paneId, () => this.currentCwd);

    // Let app shortcuts through to the window handler untouched.
    this.term.attachCustomKeyEventHandler((event) => !isAppShortcut(event));

    this.term.onData((data) => this.send({ binary: false, data }));
    // Reports that are bytes rather than text, e.g. legacy mouse encoding.
    this.term.onBinary((data) => this.send({ binary: true, data }));
    this.term.parser.registerOscHandler(7, (data) => {
      this.handleCwdReport(data);
      return true;
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.phase === "running") this.pty?.resize(cols, rows);
    });
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /** The terminal's foreground program as last looked up; `null` before the shell runs. */
  get foregroundProgram(): PtyForeground | null {
    return this.lastForeground;
  }

  /** Looks up the foreground program now. `null` if there is no running shell. */
  async foreground(): Promise<PtyForeground | null> {
    if (this.phase !== "running" || !this.pty) return null;
    const current = await this.pty.foreground();
    this.noteForeground(current);
    return current;
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
    this.queuedInput = [];
    this.detach();
    // xterm drops its queued writes on dispose, so their callbacks never run.
    this.settle(this.unsettled);
    this.unsettled = 0;
    this.pty?.kill();
    this.term.dispose();
  }

  private start(): void {
    if (this.phase !== "idle") return;
    this.phase = "starting";

    spawnPty({
      cwd: this.currentCwd,
      cols: this.term.cols,
      rows: this.term.rows,
      onData: (bytes) => this.receive(bytes),
      onExit: (exit) => this.handleExit(exit),
    }).then(
      (pty) => {
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
    else if (this.phase === "starting") this.queuedInput.push(input);
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
    if (host === "" || host === "localhost") return true;
    const local = localHostname();
    if (local) return host === local || host === local.replace(/\.local$/, "");
    this.firstHost ??= host;
    return host === this.firstHost;
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
    const last = this.lastForeground;
    this.lastForeground = current;
    if (last?.pid !== current?.pid || last?.name !== current?.name) {
      this.events.onForegroundChange(this);
    }
  }

  private handleCwdReport(data: string): void {
    const reported = parseOsc7(data);
    if (!reported || !this.isLocal(reported.host) || reported.path === this.currentCwd) return;
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
      this.fit.fit();
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
