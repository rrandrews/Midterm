import { Channel, invoke } from "@tauri-apps/api/core";
import { closePane, splitPane } from "../actions";
import { type Pty, spawnPty } from "../ipc/pty";
import { getDock } from "../layout/dock";
import { frameIdOf, listPanes } from "../state/layout";
import { selectActiveTab, useAppStore } from "../state/store";
import { sessionCount } from "../terminal/sessions";

/*
 * Development aid: exercises the real app (real webview, real PTY) and posts
 * a JSON report to a local listener, for when nobody can look at the window.
 *
 *   bun run tauri dev --config '{"build":{"devUrl":"http://localhost:1420/?selftest=PORT"}}'
 *
 * with something listening for one POST on 127.0.0.1:PORT (see docs/terminal.md).
 *
 * It runs commands in the user's login shell: harmless ones (echo, stty,
 * head, sleep), but real ones. Dev builds only.
 */

type Check = { name: string; ok: boolean; detail?: unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (what()) return true;
    await sleep(25);
  }
  return what();
}

/** A PTY whose output is collected as text, acknowledging everything. */
async function openShell(cols = 80, rows = 24) {
  const decoder = new TextDecoder();
  const shell = {
    text: "",
    bytes: 0,
    exit: undefined as { code: number | null } | undefined,
    bytesAfterExit: 0,
    pty: undefined as unknown as Pty,
    pendingAck: 0,
  };
  shell.pty = await spawnPty({
    cols,
    rows,
    onData: (chunk) => {
      shell.text += decoder.decode(chunk, { stream: true });
      shell.bytes += chunk.length;
      if (shell.exit) shell.bytesAfterExit += chunk.length;
      if (shell.pty) shell.pty.ack(chunk.length);
      else shell.pendingAck += chunk.length;
    },
    onExit: (exit) => {
      shell.exit = exit;
    },
  });
  if (shell.pendingAck) shell.pty.ack(shell.pendingAck);
  return shell;
}

async function ptyChecks(checks: Check[]): Promise<void> {
  // 1. Output must arrive as raw bytes, not a JSON array.
  const kinds = new Set<string>();
  const onData = new Channel<unknown>();
  const onEvent = new Channel<unknown>();
  let rawId = 0;
  onData.onmessage = (message) => {
    kinds.add(message instanceof ArrayBuffer ? "ArrayBuffer" : Object.prototype.toString.call(message));
    const size = message instanceof ArrayBuffer ? message.byteLength : (message as unknown[]).length;
    if (rawId) void invoke("pty_ack", { id: rawId, bytes: size });
  };
  rawId = await invoke<number>("pty_spawn", { cols: 80, rows: 24, cwd: null, onData, onEvent });
  // Small (inline) and large (fetched) chunks take different IPC paths.
  await invoke("pty_write", { id: rawId, data: "head -c 300000 /dev/zero | base64\r" });
  await sleep(2500);
  await invoke("pty_kill", { id: rawId });
  checks.push({ name: "output arrives as ArrayBuffer", ok: kinds.size === 1 && kinds.has("ArrayBuffer"), detail: [...kinds] });

  // 2. Commands run, in a login environment.
  const shell = await openShell();
  shell.pty.write("echo midterm-$((6*7))\r");
  checks.push({ name: "runs a command", ok: await waitFor(() => shell.text.includes("midterm-42"), 15000) });

  shell.pty.write('echo "env:$TERM:$TERM_PROGRAM:$COLORTERM:"; echo "path:$PATH:"\r');
  await waitFor(() => /path:\/[^\r\n]*:\r?\n/.test(shell.text), 5000);
  checks.push({
    name: "terminal environment",
    ok: shell.text.includes("env:xterm-256color:midterm:truecolor:"),
    // The PATH a login shell gives, e.g. including Homebrew when launched from Finder.
    detail: shell.text.match(/path:(\/[^\r\n]*)/)?.[1]?.slice(0, 300),
  });

  // 3. Resize reaches the shell.
  shell.pty.resize(100, 30);
  await sleep(150);
  shell.pty.write("stty size\r");
  checks.push({ name: "resize", ok: await waitFor(() => /\b30 100\b/.test(shell.text), 5000) });

  // 4. A flood arrives completely and the shell stays responsive.
  const before = shell.bytes;
  const started = performance.now();
  // The marker is computed so that the echoed command line doesn't contain it.
  shell.pty.write("head -c 6000000 /dev/zero | base64; echo flood-$((40+2))\r");
  const flooded = await waitFor(() => shell.text.includes("flood-42"), 30000);
  checks.push({
    name: "flood (8 MB) arrives in full",
    ok: flooded && shell.bytes - before >= 8_000_000,
    detail: { bytes: shell.bytes - before, ms: Math.round(performance.now() - started) },
  });

  // 5. Exit code, and nothing after the exit event.
  shell.pty.write("exit 3\r");
  await waitFor(() => shell.exit !== undefined, 5000);
  await sleep(300);
  checks.push({ name: "exit code", ok: shell.exit?.code === 3, detail: shell.exit });
  checks.push({ name: "no output after exit", ok: shell.bytesAfterExit === 0, detail: shell.bytesAfterExit });

  // 6. Kill ends a busy shell.
  const busy = await openShell();
  busy.pty.write("sleep 600\r");
  await sleep(400);
  const killedAt = performance.now();
  busy.pty.kill();
  const killed = await waitFor(() => busy.exit !== undefined, 3000);
  checks.push({ name: "kill", ok: killed, detail: { ms: Math.round(performance.now() - killedAt), exit: busy.exit } });
}

function canvasReport() {
  return Array.from(document.querySelectorAll<HTMLElement>(".terminal-host")).map((host) => {
    const screen = host.querySelector(".xterm-screen")?.getBoundingClientRect();
    const canvases = Array.from(host.querySelectorAll("canvas")).filter((c) => c.style.display !== "none");
    const webgl = canvases.find((canvas) => !canvas.className);
    return {
      screen: screen && [Math.round(screen.width), Math.round(screen.height)],
      webgl: webgl && [webgl.width, webgl.height],
      // The WebGL canvas backing store should be the CSS size × pixel ratio.
      scale: webgl && screen ? +(webgl.width / screen.width).toFixed(2) : null,
    };
  });
}

async function uiChecks(checks: Check[]): Promise<void> {
  const tab = () => selectActiveTab(useAppStore.getState());
  const focusedPane = () =>
    document.activeElement?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;

  await waitFor(() => document.querySelector(".terminal-host canvas") !== null, 5000);
  const first = listPanes(tab().layout)[0].id;
  checks.push({ name: "first terminal has focus", ok: focusedPane() === first });

  splitPane("right");
  await waitFor(() => listPanes(tab().layout).length === 2, 2000);
  await sleep(600);
  const second = listPanes(tab().layout).find((pane) => pane.id !== first)?.id;
  checks.push({ name: "split adds a focused terminal", ok: second !== undefined && focusedPane() === second });

  const ratio = window.devicePixelRatio;
  const canvases = canvasReport();
  checks.push({
    name: "terminals render at the device pixel ratio",
    ok: canvases.length === 2 && canvases.every((c) => c.scale !== null && Math.abs(c.scale - ratio) < 0.1),
    detail: { ratio, canvases },
  });

  // Re-dock the new pane along the bottom edge: its terminal must survive.
  const sessionsBefore = sessionCount();
  const dock = getDock(tab().id);
  const frameId = second && frameIdOf(tab().layout, second);
  if (dock && frameId) dock.moveTabset(frameId, { edge: "bottom" });
  await sleep(700);
  const moved = canvasReport();
  checks.push({
    name: "terminal survives a re-dock",
    ok:
      sessionCount() === sessionsBefore &&
      moved.length === 2 &&
      moved.every((c) => c.scale !== null && Math.abs(c.scale - ratio) < 0.1),
    detail: { sessions: [sessionsBefore, sessionCount()], moved },
  });
  checks.push({ name: "focus returns after a re-dock", ok: focusedPane() === second, detail: focusedPane() });

  if (second) closePane(second);
  await sleep(500);
  checks.push({
    name: "closing a pane ends its session",
    ok: listPanes(tab().layout).length === 1 && sessionCount() === sessionsBefore - 1 && focusedPane() === first,
    detail: { panes: listPanes(tab().layout).length, sessions: sessionCount() },
  });
}

export async function runSelfTest(port: string): Promise<void> {
  const checks: Check[] = [];
  const environment = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    moveBefore: "moveBefore" in Element.prototype,
    window: [window.innerWidth, window.innerHeight],
  };
  let error: string | undefined;
  try {
    await sleep(1500);
    await uiChecks(checks);
    await ptyChecks(checks);
  } catch (caught) {
    error = caught instanceof Error ? `${caught.message}\n${caught.stack}` : String(caught);
  }
  const report = { ok: !error && checks.every((check) => check.ok), error, environment, checks };
  // Opaque cross-origin POST; the listener only needs the body.
  await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify(report),
  }).catch((postError) => console.error("Self-test report could not be sent:", postError, report));
}
