import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Pty, type PtyExit, spawnPty } from "../ipc/pty";
import { openExternal } from "../ipc/shell";
import { isAppShortcut } from "../shortcuts";
import { TERMINAL_OPTIONS } from "./theme";

export type SessionEvents = {
  /** The shell exited after running for a while (see `QUICK_EXIT_MS`). */
  onExit: (session: TerminalSession) => void;
  /** Output arrived while the terminal was off screen. Fires once per stretch off screen. */
  onBackgroundOutput: (session: TerminalSession) => void;
};

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

  constructor(
    readonly paneId: string,
    private readonly events: SessionEvents,
  ) {
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

    // Let app shortcuts through to the window handler untouched.
    this.term.attachCustomKeyEventHandler((event) => !isAppShortcut(event));

    this.term.onData((data) => this.send({ binary: false, data }));
    // Reports that are bytes rather than text, e.g. legacy mouse encoding.
    this.term.onBinary((data) => this.send({ binary: true, data }));
    this.term.onResize(({ cols, rows }) => {
      if (this.phase === "running") this.pty?.resize(cols, rows);
    });
  }

  get isAttached(): boolean {
    return this.attached;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = "ended";
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

  private handleExit({ code, runtimeMs }: PtyExit): void {
    if (this.disposed) return;
    this.phase = "ended";
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
