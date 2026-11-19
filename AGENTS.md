## Project 
Midterm is a Tauri 2/React based terminal emulator. Multiple workspaces with each workspace containing any number of tabs. Tabs can contain many different elements that are maximally repositionable/resizable with nested splitting. Terminal panes, file explorer, file viewer, code editor, etc. Compact UI with no wasted space.

## Documentation
- Maintain up-to-date documentation for agent use in @docs/ directory, logically split into smallish files that pertain to a specific subsystem.
- Planned work (roadmap, backlog, bugs) is tracked in Linear (team `MID`), not in repo files. See @docs/planning.md for how it is organized and what is on hold. Short-lived implementation plans for work in progress may still go in docs/ with checklist boxes; remove them once completed.

## General coding guidelines
- Prefer trusted, actively maintained open-source libraries over rolling your own when a library solves the problem well. Before adding a dependency, check recent releases and adoption. Don't add a dependency for something a few lines of code handle, and don't reimplement what an existing dependency already does.

## Repo
- For long prompts involving multiple tasks, split the tasks logically into smaller commits.