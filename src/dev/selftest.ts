import { Channel, invoke } from "@tauri-apps/api/core";
import { closePaneNow, splitPane } from "../actions";
import { type Pty, spawnPty } from "../ipc/pty";
import { getDock } from "../layout/dock";
import { frameIdOf, listPanes } from "../state/layout";
import { closePane } from "../closing";
import { isConfirming } from "../components/ui/ConfirmDialog";
import { findPane } from "../state/layout";
import { findTabOfPane, selectActiveTab, useAppStore } from "../state/store";
import { peekSession, sessionCount } from "../terminal/sessions";
import type { TerminalSession } from "../terminal/session";
import { menuSpecs } from "../commands/nativeMenu";
import { findFiles, readTextFile, writeTextFile } from "../ipc/fs";
import { getSettings, useSettings } from "../settings/settings";
import { blockOutput, canRun, requestedMode, toggleBlocks } from "../terminal/blockMode";
import { importPlugin, removePlugin } from "../ipc/plugins";
import { refreshInstalled } from "../plugins/loader";
import { getPlugin, loadErrorOf } from "../plugins/registry";
import { getSkill, invokeSkillTool } from "../plugins/skills";
import { suggestNow, useAiSuggestions } from "../ai/engine";
import { runCommand } from "../commands/registry";
import { bundledTheme } from "../theme/bundled";
import { editTheme } from "../theme/commands";
import { svgDataUrl, sanitizeSvg } from "../icons/sanitize";
import { loadIconSet } from "../icons/state";

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
    exit: undefined as { code: number | null; runtimeMs: number } | undefined,
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
  let unacked = 0;
  onData.onmessage = (message) => {
    kinds.add(message instanceof ArrayBuffer ? "ArrayBuffer" : Object.prototype.toString.call(message));
    const size = message instanceof ArrayBuffer ? message.byteLength : (message as unknown[]).length;
    // Output can arrive before the id does; acknowledge it once we have one.
    if (rawId) void invoke("pty_ack", { id: rawId, bytes: size });
    else unacked += size;
  };
  rawId = await invoke<number>("pty_spawn", { cols: 80, rows: 24, cwd: null, onData, onEvent });
  if (unacked) await invoke("pty_ack", { id: rawId, bytes: unacked });
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
  checks.push({
    name: "exit code and runtime",
    ok: shell.exit?.code === 3 && (shell.exit?.runtimeMs ?? 0) > 100,
    detail: shell.exit,
  });
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

  // Re-dock the new pane along the bottom edge: the same terminal must end
  // up there, full width, below the first.
  const sessionsBefore = sessionCount();
  const sessionBefore = second ? peekSession(second) : undefined;
  const rectOf = (paneId: string | undefined) =>
    document.querySelector(`[data-pane-id="${paneId}"]`)?.getBoundingClientRect();
  const dock = getDock(tab());
  const frameId = second && frameIdOf(tab().layout, second);
  if (dock && frameId) dock.moveTabset(frameId, { edge: "bottom" });
  await sleep(700);
  const moved = canvasReport();
  const [top, bottom] = [rectOf(first), rectOf(second)];
  checks.push({
    name: "re-dock moves the pane to the bottom edge",
    ok:
      top !== undefined &&
      bottom !== undefined &&
      bottom.top >= top.bottom &&
      Math.abs(bottom.width - window.innerWidth) < 2 &&
      Math.abs(top.width - window.innerWidth) < 2,
    detail: { top: top && [top.x, top.y, top.width, top.height], bottom: bottom && [bottom.x, bottom.y, bottom.width, bottom.height] },
  });
  checks.push({
    name: "terminal survives a re-dock",
    ok:
      sessionBefore !== undefined &&
      peekSession(second ?? "") === sessionBefore &&
      sessionBefore.isAttached &&
      sessionCount() === sessionsBefore &&
      moved.length === 2 &&
      moved.every((c) => c.scale !== null && Math.abs(c.scale - ratio) < 0.1),
    detail: { sessions: [sessionsBefore, sessionCount()], moved },
  });
  checks.push({ name: "focus returns after a re-dock", ok: focusedPane() === second, detail: focusedPane() });

  // Dragging a separator with the mouse must not leave focus on it.
  const separator = document.querySelector<HTMLElement>("[data-separator]");
  separator?.focus();
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(100);
  checks.push({ name: "focus leaves a separator after a pointer release", ok: focusedPane() === second });

  if (second) closePaneNow(second);
  await sleep(500);
  checks.push({
    name: "closing a pane ends its session",
    ok: listPanes(tab().layout).length === 1 && sessionCount() === sessionsBefore - 1 && focusedPane() === first,
    detail: { panes: listPanes(tab().layout).length, sessions: [sessionsBefore, sessionCount()], focused: focusedPane() === first, active: `${document.activeElement?.tagName}.${document.activeElement?.className}`, pane: focusedPane(), first, second },
  });
}

/** Shell integration (OSC 7), automatic tab titles, and asking before closing a busy pane. */
async function integrationChecks(checks: Check[]): Promise<void> {
  const paneId = listPanes(selectActiveTab(useAppStore.getState()).layout)[0]?.id;
  const session = paneId && peekSession(paneId);
  if (!paneId || !session) {
    checks.push({ name: "integration: a terminal to test in", ok: false });
    return;
  }
  const tabOf = () => findTabOfPane(useAppStore.getState(), paneId);
  const savedCwd = () => {
    const tab = tabOf();
    return tab && findPane(tab.layout, paneId)?.data.cwd;
  };

  const reported = await waitFor(() => session.cwd !== undefined && savedCwd() !== undefined, 8000);
  checks.push({ name: "integration: shell reports its cwd (OSC 7)", ok: reported, detail: session.cwd });

  session.input("cd /tmp\r");
  const moved = await waitFor(() => session.cwd === "/tmp" && savedCwd() === "/tmp", 3000);
  checks.push({ name: "integration: cd updates the pane's cwd", ok: moved, detail: [session.cwd, savedCwd()] });

  const titled = await waitFor(() => tabOf()?.title === "tmp", 2000);
  checks.push({ name: "titles: idle shell names the directory", ok: titled, detail: tabOf()?.title });

  session.input("sleep 20\r");
  const busy = await waitFor(() => tabOf()?.title === "sleep", 3000);
  checks.push({ name: "titles: running program names the tab", ok: busy, detail: tabOf()?.title });

  const closing = closePane(paneId);
  const asked = await waitFor(isConfirming, 2000);
  checks.push({ name: "closing: asks before closing a busy pane", ok: asked });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await closing;
  checks.push({ name: "closing: cancelling keeps the pane", ok: !isConfirming() && tabOf() !== undefined });

  session.input("\x03");
  const idle = await waitFor(() => tabOf()?.title === "tmp", 3000);
  checks.push({ name: "titles: back to the directory after the program ends", ok: idle, detail: tabOf()?.title });
}


/** M4–M7: blocks from the real shell's OSC 133 marks, menu, files, settings. */
async function featureChecks(checks: Check[]): Promise<void> {
  const paneId = listPanes(selectActiveTab(useAppStore.getState()).layout)[0]?.id;
  const session = paneId && peekSession(paneId);
  if (!paneId || !session) {
    checks.push({ name: "features: a terminal to test in", ok: false });
    return;
  }

  // Blocks: the shell marks prompts and commands, and a command becomes a block.
  const present = await waitFor(() => session.blocks.snapshot().integration === "present", 8000);
  checks.push({ name: "blocks: shell prints OSC 133 marks", ok: present, detail: session.blocks.snapshot().integration });
  const atPrompt = await waitFor(() => canRun(session), 8000);
  checks.push({ name: "blocks: shell reaches a prompt", ok: atPrompt, detail: session.blocks.snapshot().phase });
  if (atPrompt) {
    const before = session.blocks.snapshot().blocks.length;
    session.runCommand("echo blocks-$((40+2)); false");
    const finished = await waitFor(() => {
      const blocks = session.blocks.snapshot().blocks;
      return blocks.length > before && blocks[blocks.length - 1].exitCode !== undefined;
    }, 8000);
    const blocks = session.blocks.snapshot().blocks;
    const last = blocks[blocks.length - 1];
    const output = last ? blockOutput(session, last) : "";
    checks.push({
      name: "blocks: a command becomes a block with output and exit status",
      ok: finished && last?.exitCode === 1 && output.includes("blocks-42") && !output.includes("$((") && canRun(session),
      detail: { command: last?.command, exitCode: last?.exitCode, output: output.slice(0, 200) },
    });
  }

  // A nested shell started the way `ssh host` starts one (the remote
  // command, run here instead of on a remote), gets blocks of its own.
  if (atPrompt && canRun(session)) await nestedShellCheck(checks, session);

  // Settings reach live terminals.
  const fontSize = getSettings().fontSize;
  useSettings.getState().updateSettings({ fontSize: fontSize + 1.5 });
  await sleep(50);
  const applied = (session as unknown as { term: { options: { fontSize: number } } }).term.options.fontSize;
  useSettings.getState().updateSettings({ fontSize });
  checks.push({ name: "settings: font size applies to a live terminal", ok: applied === fontSize + 1.5, detail: applied });

  // The generated menu bar is accepted by the backend.
  const menu = await invoke("menu_set", { menus: menuSpecs() }).then(
    () => true,
    (failure: unknown) => String(failure),
  );
  checks.push({ name: "menu: generated menu bar is accepted", ok: menu === true, detail: menu });

  // Editor file round trip, with the conflict check.
  const path = `/tmp/midterm-selftest-${Math.random().toString(36).slice(2)}.txt`;
  const created = await writeTextFile(path, "one\n", { kind: "absent" });
  const read = await readTextFile(path);
  const stale = created.kind === "written" ? created.version : null;
  const second = stale && (await writeTextFile(path, "two\n", { kind: "version", version: stale }));
  const conflict = stale && (await writeTextFile(path, "three\n", { kind: "version", version: stale }));
  const reread = await readTextFile(path);
  checks.push({
    name: "files: write, read, and refuse a stale save",
    ok:
      created.kind === "written" &&
      read.kind === "text" &&
      read.text === "one\n" &&
      second?.kind === "written" &&
      conflict?.kind === "conflict" &&
      reread.kind === "text" &&
      reread.text === "two\n",
    detail: { created: created.kind, second: second?.kind, conflict: conflict?.kind },
  });
  await invoke("fs_trash", { paths: [path] }).catch(() => {});

  // Fuzzy file open can list a real directory.
  const cwd = session.cwd;
  const found = cwd ? await findFiles(cwd, 50).catch((failure: unknown) => String(failure)) : "no cwd";
  checks.push({
    name: "palette: lists files under the terminal's directory",
    ok: typeof found !== "string",
    detail: typeof found === "string" ? found : found.paths.length,
  });
}

/**
 * MID-64: `eval` of the remote command `ssh host` would send starts an
 * integrated shell with its own aid in a temporary directory; its commands
 * become nested blocks and `exit` returns to the root scope with the pane's
 * cwd unchanged. Skipped when the shell has no ssh wrapper (fish, or the
 * setting off).
 */
async function nestedShellCheck(checks: Check[], session: TerminalSession): Promise<void> {
  const cwdBefore = session.cwd;
  const count = () => session.blocks.snapshot().blocks.length;
  const lastBlock = () => session.blocks.snapshot().blocks[count() - 1];
  const before = count();
  session.runCommand('[ -n "${_midterm_ssh_dir-}" ] && eval "$(cat "$_midterm_ssh_dir/remote-command")"');
  const nested = await waitFor(() => session.blocks.snapshot().nested && canRun(session), 8000);
  if (!nested) {
    const last = lastBlock();
    // `[ -n … ]` failed: no wrapper in this shell.
    if (last?.exitCode === 1 && count() === before + 1) return;
    checks.push({ name: "ssh: the remote command starts a nested shell", ok: false, detail: session.blocks.snapshot() });
    return;
  }
  const inner = count();
  session.runCommand("echo nested-$((40+2))");
  const ran = await waitFor(() => count() > inner && lastBlock()?.exitCode !== undefined, 8000);
  const block = lastBlock();
  const output = block ? blockOutput(session, block) : "";
  session.runCommand("exit");
  const back = await waitFor(() => !session.blocks.snapshot().nested && canRun(session), 8000);
  checks.push({
    name: "ssh: a nested shell's commands are nested blocks, and exit returns",
    ok: ran && block?.nested === true && output.includes("nested-42") && back && session.cwd === cwdBefore,
    detail: { nested: block?.nested, output: output.slice(0, 100), back, cwd: session.cwd, cwdBefore },
  });
}

/** Switching theme reaches CSS variables, a live terminal's palette, and the editor pane plugin opens. */
async function themeChecks(checks: Check[]): Promise<void> {
  const paneId = listPanes(selectActiveTab(useAppStore.getState()).layout)[0]?.id;
  const session = paneId ? peekSession(paneId) : undefined;
  const css = () => getComputedStyle(document.documentElement).getPropertyValue("--color-app").trim();
  const before = { css: css(), red: session?.theme.red };
  useSettings.getState().updateSettings({ theme: "solarized-light" });
  await sleep(200);
  const light = bundledTheme("solarized-light");
  const after = { css: css(), red: session?.theme.red, scheme: document.documentElement.style.colorScheme };
  checks.push({
    name: "themes: switching updates CSS variables and a live terminal's palette",
    ok: !!light && after.css === light.background && after.red === light.ansi.red && after.scheme === "light" && before.css !== after.css,
    detail: { before, after },
  });
  editTheme("solarized-light");
  const editor = await waitFor(() => document.querySelector('[data-pane-kind="theme-editor"] [data-token="fg"]') !== null, 3000);
  checks.push({ name: "themes: the theme editor pane opens", ok: editor });
  const editorPane = (document.querySelector('[data-pane-kind="theme-editor"]') as HTMLElement | null)?.dataset.paneId;
  if (editorPane) closePaneNow(editorPane);
  useSettings.getState().updateSettings({ theme: "midterm-dark" });
  await sleep(100);
}

/** File icons in the real WebView: the default set's assets load, and hostile SVG is defused. */
async function iconChecks(checks: Check[]): Promise<void> {
  const decodedWidth = async (url: string) => {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    return img.naturalWidth;
  };
  const material = await loadIconSet("material");
  const image = material?.icon({ name: "package.json", kind: "file", expanded: false, light: false });
  const width = image && "url" in image ? await decodedWidth(image.url) : 0;
  checks.push({ name: "icons: the Material set loads and its icons decode", ok: width > 0, detail: { image, width } });

  const flag = window as unknown as { __midtermIconXss?: boolean };
  flag.__midtermIconXss = false;
  const clean = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" onload="window.__midtermIconXss=true"><script>window.__midtermIconXss=true</script><circle cx="8" cy="8" r="6"/></svg>',
  );
  const cleanWidth = clean ? await decodedWidth(svgDataUrl(clean)) : 0;
  await sleep(50);
  checks.push({
    name: "icons: hostile SVG is sanitized, still draws, and runs nothing",
    ok: !!clean && !/script|onload/i.test(clean) && cleanWidth > 0 && !flag.__midtermIconXss,
    detail: { clean, cleanWidth },
  });
}

/** The example plugin imported, opened from the palette, disabled (placeholder) and removed again. */
async function pluginChecks(checks: Check[]): Promise<void> {
  const id = "scratchpad";
  const pane = () => document.querySelector(`[data-pane-kind="${id}"]`);
  await importPlugin(`${__MIDTERM_ROOT__}/examples/plugins/${id}`, true);
  await refreshInstalled([id]);
  const loaded = await waitFor(() => {
    const entry = getPlugin(id);
    return (entry?.source.type === "imported" && !entry.source.stub) || loadErrorOf(id) !== undefined;
  }, 5000);
  checks.push({
    name: "plugins: an imported plugin's module loads through plugin://",
    ok: loaded && loadErrorOf(id) === undefined,
    detail: loadErrorOf(id) ?? getPlugin(id)?.source,
  });

  const ran = runCommand(`pane.new.${id}`);
  const opened = await waitFor(() => pane()?.querySelector("textarea.scratchpad") != null, 3000);
  const styled = opened && getComputedStyle(pane()!.querySelector("textarea")!).resize === "none";
  checks.push({ name: "plugins: its pane opens from the generated palette command", ok: ran && opened, detail: { ran } });
  checks.push({ name: "plugins: its stylesheet applies", ok: styled });

  const skill = await invokeSkillTool(`${id}.text`, "read_notes", {});
  const fileSkill = getSkill(`${id}.notes`);
  const builtinSkill = await invokeSkillTool("terminal.commands", "recent_blocks", { count: 1 });
  const refused = await invokeSkillTool("terminal.commands", "run_command", { command: "echo no" });
  const invalid = await invokeSkillTool(`${id}.text`, "read_notes", { extra: 1 });
  checks.push({
    name: "plugins: skills (code, SKILL.md, built in; write refused without confirmation; input validated)",
    ok: skill.ok && fileSkill !== undefined && builtinSkill.ok && !refused.ok && !invalid.ok,
    detail: { skill, fileSkill: fileSkill?.skill.title, builtinSkill: builtinSkill.ok || builtinSkill, refused, invalid },
  });

  useSettings.getState().updatePluginEntry(id, { enabled: false });
  const placeholder = await waitFor(() => pane()?.querySelector(`[data-plugin-placeholder="${id}"]`) != null, 2000);
  checks.push({ name: "plugins: disabling shows a placeholder and keeps the pane", ok: placeholder });

  useSettings.getState().updatePluginEntry(id, { enabled: true });
  const back = await waitFor(() => pane()?.querySelector("textarea.scratchpad") != null, 3000);
  checks.push({ name: "plugins: enabling brings the pane back", ok: back });

  const paneId = (pane() as HTMLElement | null)?.dataset.paneId;
  if (paneId) closePaneNow(paneId);
  await removePlugin(id).catch(() => {});
  await refreshInstalled();
  checks.push({ name: "plugins: removing unregisters it", ok: getPlugin(id) === undefined });
}

/**
 * M10: suggestions end to end through a `custom` model profile pointed at
 * scripts/ai-stub.ts: inert without a profile, then a suggestion shows as
 * ghost text, with the secret in the history redacted on the way.
 */
async function aiChecks(checks: Check[], stubPort: string): Promise<void> {
  const paneId = listPanes(selectActiveTab(useAppStore.getState()).layout)[0]?.id;
  const session = paneId ? peekSession(paneId) : undefined;
  if (!paneId || !session) {
    checks.push({ name: "ai: a terminal to test in", ok: false });
    return;
  }
  if (requestedMode(paneId) !== "blocks") toggleBlocks(paneId);
  // Switching to the block terminal keeps the pane's shell.
  await sleep(50);
  checks.push({ name: "terminal: switching to the block terminal keeps the session", ok: peekSession(paneId) === session });
  await waitFor(() => canRun(session), 8000);
  const before = session.blocks.snapshot().blocks.length;
  session.runCommand("export MIDTERM_SELFTEST_PASSWORD=hunter2-selftest; true");
  await waitFor(() => session.blocks.snapshot().blocks.length > before && canRun(session), 8000);
  const input = () => document.querySelector<HTMLTextAreaElement>(`[data-pane-id="${CSS.escape(paneId)}"] .blocks-input-text`);
  const ghost = () => document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"] .blocks-input-ghost`)?.textContent ?? "";
  await waitFor(() => input() !== null, 3000);
  input()?.focus();
  await sleep(600);
  checks.push({ name: "ai: nothing is asked before a model profile is chosen", ok: useAiSuggestions.getState()[paneId] === undefined });

  const savedAi = useSettings.getState().ai;
  useSettings.getState().updateAi({
    suggestions: true,
    profiles: [{ id: "selftest", name: "Self-test stub", provider: "custom", baseUrl: `http://127.0.0.1:${stubPort}/v1`, model: "stub-model", cliPath: "" }],
    defaultProfile: "selftest",
    features: {},
  });
  const asked = suggestNow(paneId);
  const shown = await waitFor(() => ghost().includes("echo "), 8000);
  checks.push({
    name: "ai: a suggestion from the provider shows as ghost text, secrets redacted",
    ok: asked && shown && ghost().includes("echo midterm-ai-ok"),
    detail: { ghost: ghost(), entry: useAiSuggestions.getState()[paneId] },
  });
  input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  await sleep(100);
  checks.push({ name: "ai: ⇥ accepts it into the editor", ok: input()?.value === "echo midterm-ai-ok", detail: input()?.value });
  useSettings.getState().updateAi({ profiles: savedAi.profiles, defaultProfile: savedAi.defaultProfile, features: savedAi.features });
  if (input()) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input(), "");
    input()?.dispatchEvent(new Event("input", { bubbles: true }));
  }
  toggleBlocks(paneId);
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
    await pluginChecks(checks);
    await themeChecks(checks);
    await iconChecks(checks);
    await integrationChecks(checks);
    await featureChecks(checks);
    const stubPort = new URLSearchParams(location.search).get("aistub");
    if (stubPort) await aiChecks(checks, stubPort);
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
