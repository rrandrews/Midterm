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
| tabset | a **frame**: one or more panes (as subtabs), the options menu, drag handle (rightmost) and drop target |
| tab | a **pane** (`PaneNode`); its `data` is `PaneData` (`{ kind }`); in a frame with several, a **subtab** |

Most frames hold one pane, and then the library's tab list is hidden. A
frame with several panes shows them as subtabs ([Subtabs](#subtabs)).
Drops: the left/right/top/bottom of a frame (split it), its middle or its
subtab strip (add as a subtab), and the edges of the whole layout (dock
there). `disableDrop` in `PaneLayout.tsx` only refuses dropping a frame
onto itself.

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

## Subtabs

Any frame can hold several panes, shown one at a time as **subtabs**: the
library's tabs, drawn by `renderTab` (`src/components/layout/Subtab.tsx`).
A frame with more than one pane gets the class `has-subtabs`, and its
header turns from floating hover controls into a strip above the content:
subtabs on the left, the … menu and drag handle at the right (still shown
on hover or while active), and between them an invisible drag handle
(`.subtab-gap`, a second `TabsetDragHandle`: the library only starts a
frame drag from one) so the empty space drags the whole frame.
One-pane frames keep the floating controls and lose no space.

- **Making them**: the pane menu's **New subtab ›** (any enabled plugin),
  the palette's "New subtab" (`pane.newSubtab`, the default kind) and "New
  X subtab" (`pane.newSubtab.<kind>`), or dragging a pane onto the middle
  of another or onto a subtab strip. Dragging a subtab out of the strip
  splits it off or docks it, like any pane; the grip drags all of them.
  `addSubtab` in `src/actions.ts`. Dropping a frame's grip on a top-level
  tab or `+` moves all its subtabs together (`notePaneDrag` records them,
  the shown one first; the store's `movePaneToTab` / `movePaneToNewTab`
  take a list).
- **What a subtab shows**: the plugin's `icon` (`PluginIcon`), then the
  name the user gave it, else the pane's `tabTitle`, else the plugin's
  name. A plugin with `pane.subtabIconOnly` (the explorer) gets an
  icon-only square unless the user names it. Labels follow `tabTitle`
  through `subscribeTitles` in `src/plugins/tabTitles.ts`.
- **Naming**: right-click → Rename subtab… (or double-click). The name is
  the pane's `title` (`renameSubtab`, `paneName` in `src/state/layout.ts`);
  an empty name goes back to the automatic label. The menu acts on that
  pane by id; opening it does not select the subtab. Panes get no title
  otherwise: older builds titled every pane with its kind, and
  `restoreState` drops all titles from files before version 3. The rest of the right-click menu is
  the pane's.
- **⇧⌘1 … ⇧⌘9, ⇧⌘0** show the first to tenth subtab of the active pane's
  frame (`pane.subtab1` … `pane.subtab10`, `selectSubtabByDigit`); "Next
  subtab" / "Previous subtab" are in the palette, unbound. Note that macOS
  takes ⇧⌘3, ⇧⌘4 and ⇧⌘5 for screenshots unless they are turned off in
  System Settings → Keyboard → Keyboard Shortcuts.
- **Active pane**: only a shown pane can be active (`activePaneId` falls
  back to the subtab its frame shows). `focusPane` shows a hidden pane in
  the mounted layout first (`showSubtab` in `src/layout/dock.ts`: selects
  its subtab, and restores the layout if another frame is maximized), then
  focuses it again on the next frame; `setActivePane` selects it in the
  stored layout (`selectPaneInLayout`), for tabs that are not mounted. In
  `onModelChanged`, a subtab the user selected (pointer or keyboard)
  becomes the active pane and the focus target (`notePaneFocused`), even
  when keyboard focus stays on the strip; when a drop hides the active
  pane, its frame's shown subtab takes over. Clicking a subtab also
  focuses its pane.
- **Closing** the shown subtab shows the one after it (else before it)
  and focuses it (`closingNeighbour`). Store-side removals do the same
  (`removePanes` picks the successor before the library tidies the
  layout; `withLayout` makes it active). The library's Delete/Backspace
  on a focused subtab is turned into `closePane` (`onBeforeModelChange`),
  so it asks like any close.
- Hidden subtabs stay mounted in the library's hidden parking element, so
  terminals keep running (`fitNow` skips a host with no size). Their
  `getBoundingClientRect` is empty, so ⌥⌘arrows skip them.
- A frame's size limits come from the pane it shows; switching subtabs
  re-syncs them.

### Styling

In `dock.css`, from variables on `.pane-frame` that a theme or a plugin's
CSS can override: `--subtab-height` (24px), `--subtab-strip-bg` (the app
background, a little darker than pane content), `--subtab-selected-bg`,
`--subtab-hover-bg`, `--subtab-divider` (the hairlines between subtabs,
left out beside the selected one), `--subtab-fg`, `--subtab-selected-fg`.
There is no line between the strip and the content. A drop position in
the strip is an accent bar on the subtab (`data-drop-before` /
`data-drop-after`); a drop on a frame's middle reads "Add as subtab".

## Pane numbers and ⌥ digits

⌥1 … ⌥9 focus the first to ninth pane of the active tab and ⌥0 the tenth
(`pane.select1` … `pane.select10`, hidden commands in `src/commands/core.ts`
running `selectPaneByDigit` in `src/actions.ts`). A number with no pane does
nothing. If another pane is maximized, the layout is restored first.

The order is `visiblePanes` order (depth-first through the splits, then
floating panes, counting each frame's shown subtab only), not on-screen geometry, so a pane keeps its number while the user
resizes. `paneNumbers`, `paneNumberLabel` and `paneIndexForDigit` in
`src/state/layout.ts` are the single source of that mapping, for both the
shortcuts and the overlay. The overlay labels each pane with its command's
binding as it is now (`activePaneNumbers`): the key alone for ⌥ plus one key
(the default), the whole shortcut otherwise, and no badge for a command
with no binding.

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
| `pane-header` | hover controls, floated over the top-right of the pane; the subtab strip in a `has-subtabs` frame |
| `pane-tablist` | the subtabs (hidden in a one-pane frame) |
| `subtab` | one subtab (`Subtab.tsx`); `is-icon-only` for the icon-only square |
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
2. Drag onto the middle of a pane: "Add as subtab"; dropping stacks it.
   Drag a subtab out of the strip onto another pane's side: it splits off.
   ⇧⌘1/⇧⌘2 switch subtabs; right-click a subtab → Rename.
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
