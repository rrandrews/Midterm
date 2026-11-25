# Pane layout

Each tab's panes are arranged by the `Workspace` component of
[`react-resizable-panels`](https://github.com/bvaughn/react-resizable-panels)
(imported as `Dock` in `src/components/layout/PaneLayout.tsx`). It provides
the nested splits, resizing, drag-to-dock with drop regions, and a
serializable layout model. We style it and constrain it; we do not
reimplement any of it.

## Vocabulary

The library and the app use the same words for different things:

| Library term | In Midterm |
|---|---|
| workspace | one tab's pane layout (`Layout`) |
| split | a split (horizontal or vertical) |
| tabset | a pane's **frame**: the options menu, drag handle (rightmost) and drop target |
| tab | a **pane** (`PaneNode`); its `data` is `PaneData` (`{ kind }`) |

Every frame holds exactly one pane. The library's per-tabset tab list is
hidden, and drops that would stack a second pane into a frame are rejected
(`rejectStacking` in `PaneLayout.tsx`). Allowed drops: the left/right/top/
bottom of a frame (split it) and the edges of the whole layout (dock there).

## Where the layout lives

- `Tab.layout` in the store is the saved model.
- The mounted component is **uncontrolled**: it starts from `tab.layout` and
  calls `onModelChanged` after each completed change, which stores the new
  model.
- Only the active tab's layout is mounted.

So there are two ways to change a layout, and which one to use depends on
whether it is mounted:

| Layout is… | Change it with | Example |
|---|---|---|
| mounted (active tab) | its imperative handle, `getDock(tab)` | split, close, change kind |
| not mounted, or the change spans tabs | a store action that edits `tab.layout` and bumps `tab.layoutRev` | shell exits in a background tab; move pane to new tab |

`PaneLayout` is keyed by `tab.id` and `tab.layoutRev`, so bumping the revision
remounts it with the new model. Remounting is cheap because pane state lives
outside React.

Between a store-side edit and the remount, the old layout is still mounted
but stale. Two guards keep it from doing damage: `getDock(tab)` only returns
the handle registered for the tab's *current* revision (so pass the tab as it
is in the store now), and `onModelChanged` ignores reports from an instance
whose revision is no longer current.

Pure helpers for reading and editing models are in `src/state/layout.ts`
(`listPanes`, `findPane`, `frameIdOf`, `removePane`, …). `removePane` relies on
the library's `normalizeWorkspaceModel` to collapse the splits left behind.

## Active pane

The active pane is tracked by the app, not the library: pane content is
rendered through portals, so the library's own "active tabset" does not see
clicks or focus inside a pane. `PaneHost` (`src/plugins/PaneHost.tsx`) marks its pane active on focus or
pointer-down (`setActivePane` in the store) and gets the `is-active` class;
CSS in `src/styles/dock.css` styles the frame from that with `:has()`.

## Pane numbers and ⌥ digits

⌥1 … ⌥9 focus the first to ninth pane of the active tab and ⌥0 the tenth
(`pane.select1` … `pane.select10`, hidden commands in `src/commands/core.ts`
running `selectPaneByDigit` in `src/actions.ts`). A number with no pane does
nothing. If another pane is maximized, the layout is restored first.

The order is `listPanes` order (depth-first through the splits, then floating
panes), not on-screen geometry, so a pane keeps its number while the user
resizes. `paneNumbers`, `paneNumberLabel` and `paneIndexForDigit` in
`src/state/layout.ts` are the single source of that mapping, for both the
shortcuts and the overlay.

Holding ⌥ alone for 250ms shows the number on each pane
(`src/layout/paneNumbers.ts`, installed in `App.tsx`; drawn by
`PaneNumberBadge` in `PaneHost`, styled `.pane-number` in `dock.css`, the
active pane's in the accent). The numbers are a snapshot in a small zustand
store. They hide on ⌥ release, window blur, the page hiding, another
modifier going down, or any key that is not ⌥+digit, and they never appear
with fewer than two panes or while shortcuts are suspended. ⌥+digit keeps
them up while ⌥ stays held. The badge is `pointer-events: none` and absolutely
positioned, so it does not affect layout. Like all shortcuts, ⌥+digit is
matched on `event.code` in the capture phase, so terminals never see the
characters ⌥ would type ("¡™£…").

## Styling

The library renders unstyled elements. Class names are assigned in
`PaneLayout.tsx` (`CLASS_NAMES`) and defined in `src/styles/dock.css`:

| Class | Element |
|---|---|
| `pane-frame` | a pane's frame |
| `pane-header` | hover controls, floated over the top-right of the pane |
| `pane-separator` | 1px hairline between panes, accent grip on hover/drag |
| `pane-drop` | the drop indicator (label comes from its `data-region` / `data-edge`) |
| `pane-drag-preview` | chip that follows the pointer during a drag |

Props passed to the layout component must be referentially stable (module
constants or `useCallback`), because every pane re-renders when they change.

## Things to know

- The library's `Workspace` component is new and the package releases often.
  Read the changelog before upgrading, and re-run the manual checks below.
- WebKit has no `Element.moveBefore`, so when the layout restructures, panes
  that shift are re-inserted into the document and lose keyboard focus.
  `onModelChanged` calls `restoreFocusAfterLayoutChange()` for that.
- Pane content must not give its split cell an intrinsic size: `.pane` has
  `contain: size`. Without it a terminal's canvas holds a shrinking cell at
  its old width, and refits walk it down a few columns per frame.
- An initial size given in pixels (e.g. a 220px explorer) becomes a
  percentage once the user resizes that split.

## Manual checks after touching the layout

Run `bun run dev` and open `localhost:1420/?mockup`:

1. Drag a pane by its grip onto each side of another pane, and onto an edge
   of the window. The indicator names the result; dropping does it.
2. Drag onto the middle of a pane: no indicator, nothing happens.
3. ⌘D, ⇧⌘D, ⌘W, ⌥⌘arrows: the new or neighbouring pane has focus each time.
4. Drag a separator; panes resize and terminals refit.
5. Pane menu → Move to new tab, then switch back: both tabs are intact.
6. Type in a terminal, drag it elsewhere: the text is still there.

## Moving panes between tabs

The library cancels a pane drag released outside the layout, so dropping a
pane on a tab is handled by `src/layout/paneDrag.ts`: the drag preview
(rendered only during a pane drag) records the dragged pane, and a
window-level pointer listener checks what is under the pointer on release.
Elements with `data-pane-drop="<tab id>"` (each tab) or `data-pane-drop="new"`
(the `+` button) accept the drop; the hovered one gets
`data-pane-drop-hover`. The move itself is the store's `movePaneToTab` (the
pane is appended to the right of the target tab's layout) or
`movePaneToNewTab`.

A pane that is alone in its tab cannot be dragged (the library disables
dragging the only frame), so the pane menu also has **Move to tab ›**,
listing the workspace's other tabs and a new tab. A drop only counts while
the library's drag preview exists; the window losing focus cancels both.

Tabs themselves are reordered by dragging (dnd-kit sortable, in
`TabStrip.tsx`; a 5px move threshold keeps clicks and double-clicks
working). When they do not fit, the strip scrolls sideways (wheel or
trackpad) and keeps the active tab in view.

## Pane size limits

Every frame is at least 96px wide and 56px high (`tabsetMinWidth` /
`tabsetMinHeight`). A plugin can ask for other limits with `pane.size`
(pixels; see [plugins.md](plugins.md#the-contract)). `src/layout/paneSize.ts`
clamps them (`clampSizeLimits`) and writes them onto the frame as the
library's tabset `minWidth`, `minHeight`, `maxWidth`, `maxHeight`:

- `PaneLayout` mounts with `withSizeLimits(tab.layout)`, so layouts edited
  in the store (moves between tabs, restore) get them;
- after each model change, `frameLimitUpdates` finds frames whose limits no
  longer match their pane's kind (a split, a drop, a change of pane type)
  and `syncSizeLimits` fixes them with `updateTabset`;
- a change in the plugin registry (an imported plugin loading, enabled or
  replaced) syncs the mounted layout too.

The library only applies a maximum while something else in the split can
take the rest of the space, and shows a frame within its limits without
changing its saved size.

## Maximizing a pane

⇧⌘↩ or the pane menu toggles `toggleMaximizePane` (the library's
`maximizeTabset` / `restoreTabset`). The maximized frame is marked
`data-tabset-maximized`; `dock.css` hides the other frames and the
separators while it is, since some of their layers would paint over it.
The state is part of the layout model (`maximizedTabsetId`), so it is saved.
