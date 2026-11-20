## Project 
Midterm is a Tauri 2/React based terminal emulator. Multiple workspaces with each workspace containing any number of tabs. Tabs can contain many different elements that are maximally repositionable/resizable with nested splitting. Terminal panes, file explorer, file viewer, code editor, etc. Compact UI with no wasted space.

## Documentation
- Maintain up-to-date documentation for agent use in @docs/ directory, logically split into smallish files that pertain to a specific subsystem.
- Planned work (roadmap, backlog, bugs) is tracked in Linear (team `MID`), not in repo files. See @docs/planning.md for how it is organized and what is on hold. Short-lived implementation plans for work in progress may still go in docs/ with checklist boxes; remove them once completed.

## General coding guidelines
- When given tasks directly (rather than pointed to an issue) that require modification of the codebase, first create a proper issue and/or project on Linear for the task.
- Mark tasks as done when you finish.
- Prefer trusted, actively maintained open-source libraries over rolling your own when a library solves the problem well. Before adding a dependency, check recent releases and adoption. Don't add a dependency for something a few lines of code handle, and don't reimplement what an existing dependency already does.

## Testing
- Developer `tauri dev` builds: `MIDTERM_KEYSTORE=file` keeps AI keys in `~/.config/midterm-dev/keys.json` instead of the Keychain (no password prompt per rebuild; debug builds on macOS/Unix only, ignored by release and `dev:mcp` builds). See docs/ai.md#keys.
- For active testing use `bun run dev:mcp` to start an app version that can be monitored via the tauri mcp server. It is self-contained: vite on port 1430 (runs alongside the developer's `tauri dev` on 1420), its own app data (`com.ron.midterm.mcp`) and in-memory AI keys (no Keychain unless `MIDTERM_KEYSTORE=os` is set), so no backup/restore of settings is needed.

## Repo
- For long prompts involving multiple tasks, split the tasks logically into smaller commits.