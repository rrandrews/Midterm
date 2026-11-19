# Planning

Planned work lives in **Linear**, not in this repo: workspace `rr-midterm`,
team **Midterm** (key `MID`, so issues are `MID-123`). Agents can read and
write it through the Linear MCP. Check Linear before starting a feature, and
check for an existing issue before filing a new one.

## How Linear is organized

- **One team (`MID`)**. Everything goes in this team.
- **Projects** are bodies of work that can be finished, like M1 to M10
  were. Each project has a description, and large ones are split into
  milestones. Project status is *Planned* (queued), *In Progress*,
  *Backlog*, *Completed* or *Canceled*.
- **Issues** are one fix or feature each, small enough for a commit or a
  short series of commits. Small bugs and follow-ups that don't belong to a
  project stay unattached in the backlog.
- **Labels**:
  - *Type*: `Bug`, `Feature` or `Improvement`.
  - *Area* (a group; pick exactly one): `Terminal`, `Shell Integration`,
    `Blocks`, `Explorer`, `Editor`, `Layout`, `Plugins`, `Themes`, `AI`,
    `Platform`.
- **Statuses**: Backlog → Todo → In Progress → Done (also Canceled and
  Duplicate). Move an issue to In Progress when work starts. Mention its
  ID (`MID-123`) in the commit message or branch name so Linear links
  them.

## On hold: cross-platform and packaging

The **Cross-platform & Packaging** project (Linux/Windows support,
bundling, signing, auto-update, CI) is **shelved on purpose**. It is in
*Backlog* with Low priority and the `On hold` project label. Don't pick up
its issues, and don't design features around Linux or Windows yet, until
the user takes it off hold. macOS feature work comes first.

## Current projects

- **Terminal & Shell Hardening**: shell integration edge cases, OSC 133,
  blocks-mode gaps.
- **AI Agent & Assistant**: an agent over plugin skills, suggestions in
  classic mode, streaming, explain/fix on a block, AI in the plugin API.
- **Plugin Platform v2**: sandboxed plugins, updates and an index,
  contributions other than panes.
- **Stacked & Floating Panes**: tabbed frames, floating and pop-out panes.
- **Cross-platform & Packaging**: on hold (see above).

Explorer, editor and theme follow-ups are backlog issues with no project.
