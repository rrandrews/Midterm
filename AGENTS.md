## Project 
Midterm is a Tauri 2/React based terminal emulator. Multiple workspaces with each workspace containing any number of tabs. Tabs can contain many different elements that are maximally repositionable/resizable with nested splitting. Terminal panes, file explorer, file viewer, code editor, etc. Everything is a plugin.

## Documentation
- Maintain up-to-date documentation for agent use in @docs/ directory, logically split into smallish files that pertain to a specific subsystem.

## General coding guidelines
- When given tasks directly (rather than pointed to an issue) that require modification of the codebase, first create a proper issue and/or project on Linear for the task.
- Mark tasks as done when you finish.
- Prefer trusted, actively maintained open-source libraries over rolling your own when a library solves the problem well. Before adding a dependency, check recent releases and adoption. Don't add a dependency for something a few lines of code handle, and don't reimplement what an existing dependency already does.
- Always use Midterm's tooltip component (`Tip`, `Help`, or `AnchoredTip` from `src/components/ui/Tooltip.tsx`) rather than native HTML `title` attributes (system tooltips).

## Testing
- Developer `tauri dev` builds: `MIDTERM_KEYSTORE=file` keeps AI keys in `~/.config/midterm-dev/keys.json` instead of the Keychain (no password prompt per rebuild; debug builds on macOS/Unix only, ignored by release and `dev:mcp` builds). See docs/ai.md#keys.
- For active testing use `bun run dev:mcp` to start an app version that can be monitored via the tauri mcp server. It is self-contained: vite on port 1430 (runs alongside the developer's `tauri dev` on 1420), its own app data (`com.ron.midterm.mcp`) and in-memory AI keys (no Keychain unless `MIDTERM_KEYSTORE=os` is set), so no backup/restore of settings is needed.
  - Driving it: in `webview_execute_js`, `await import('/src/...')` reaches the app's live modules (e.g. `openSettings('plugin:block-terminal')`, `newTab('block-terminal')`, `runFromBlocks(peekSession(id), 'cmd')`). If a `webview_interact` click doesn't focus an input, focus it via JS, then use `webview_keyboard`.
- Browser vs. app: `bun run dev` in a browser (Playwright) starts faster and is fine for pure UI work (layout, styling, settings controls), but it runs on the PTY mock (`src/ipc/ptyMock.ts`) in Chromium, not the app's WebKit webview. Use `dev:mcp` for anything touching real shells (foreground process, shell integration, ssh), Tauri IPC/native features (files, Keychain, plugins on disk, menus, windows), terminal rendering (WebGL, transparency), and for the final visual check of any UI change.

## Repo
- For long prompts involving multiple tasks, split the tasks logically into smaller commits.
- Before each commit submit your code to Codex for review.