import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Pty, spawnPty } from "../ipc/pty";
import { openExternal } from "../ipc/shell";
import { isAppShortcut } from "../shortcuts";
import { TERMINAL_OPTIONS } from "./theme";

export type SessionEvents = {
  /** The shell exited after running for a while (see `QUICK_EXIT_MS`). */
  onExit: (paneId: string) => void;
  /** Output arrived while the terminal was off screen. Fires once per stretch off screen. */
  onBackgroundOutput: (paneId: string) => void;
};

/**
 * A shell that dies this soon after starting probably failed to start.
 * Its pane stays open showing the error instead of vanishing (and, for a
 * tab's last pane, instead of looping through close-tab → new-tab → spawn).
 */
const QUICK_EXIT_MS = 1500;

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

  private pty: Pty | null = null;
  private spawned = false;
  private startedAt = 0;
  private disposed = false;
  private attached = false;
  private notifiedBackgroundOutput = false;
  /** Input typed, and output processed, before the PTY handle was available. */
  private pendingInput = "";
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

    this.term.onData((data) => {
      if (this.pty) this.pty.write(data);
      else this.pendingInput += data;
    });
    this.term.onResize(({ cols, rows }) => this.pty?.resize(cols, rows));
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
    this.detach();
    this.pty?.kill();
    this.pty = null;
    this.term.dispose();
  }

  private start(): void {
    if (this.spawned) return;
    this.spawned = true;
    this.startedAt = performance.now();

    spawnPty({
      cols: this.term.cols,
      rows: this.term.rows,
      onData: (bytes) => this.receive(bytes),
      onExit: ({ code }) => this.handleExit(code),
    }).then(
      (pty) => {
        if (this.disposed) {
          pty.kill();
          return;
        }
        this.pty = pty;
        // Catch up on whatever happened while the spawn was in flight.
        pty.resize(this.term.cols, this.term.rows);
        if (this.pendingAck) pty.ack(this.pendingAck);
        if (this.pendingInput) pty.write(this.pendingInput);
        this.pendingAck = 0;
        this.pendingInput = "";
      },
      (error) => this.report(`Could not start a shell: ${String(error)}`),
    );
  }

  private receive(bytes: Uint8Array): void {
    if (this.disposed) return;
    // Acknowledge only once xterm has parsed the chunk: that is what paces
    // the backend's reads to how fast the terminal can actually render.
    this.term.write(bytes, () => {
      if (this.pty) this.pty.ack(bytes.length);
      else this.pendingAck += bytes.length;
    });
    if (!this.attached && !this.notifiedBackgroundOutput) {
      this.notifiedBackgroundOutput = true;
      this.events.onBackgroundOutput(this.paneId);
    }
  }

  private handleExit(code: number | null): void {
    if (this.disposed) return;
    this.pty = null;
    if (performance.now() - this.startedAt < QUICK_EXIT_MS) {
      this.report(`Shell exited immediately${code === null ? "" : ` (code ${code})`}.`);
      return;
    }
    this.events.onExit(this.paneId);
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
