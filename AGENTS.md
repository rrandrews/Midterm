## Project 
Midterm is a Tauri 2/React based terminal emulator. Multiple workspaces with each workspace containing any number of tabs. Tabs can contain many different elements that are maximally repositionable/resizable with nested splitting. Terminal panes, file explorer, file viewer, code editor, etc. Compact UI with no wasted space.

## Documentation
- Maintain up-to-date documentation for agent use in @docs/ directory, logically split into smallish files that pertain to a specific subsystem.
- Roadmaps/plan files should be detailed and include checklist boxes. Remove them once completed.

## General coding guidelines
- Prefer trusted, actively maintained open-source libraries over rolling your own when a library solves the problem well. Before adding a dependency, check recent releases and adoption. Don't add a dependency for something a few lines of code handle, and don't reimplement what an existing dependency already does.

## Repo
- For long prompts involving multiple tasks, split the tasks logically into smaller commits.