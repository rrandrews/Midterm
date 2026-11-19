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
| tabset | a pane's **frame**: the drag handle, menu and drop target |
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
| mounted (active tab) | its imperative handle, `getDock(tabId)` | split, close, change kind |
| not mounted, or the change spans tabs | a store action that edits `tab.layout` and bumps `tab.layoutRev` | shell exits in a background tab; move pane to new tab |

`PaneLayout` is keyed by `tab.id` and `tab.layoutRev`, so bumping the revision
remounts it with the new model. Remounting is cheap because pane state lives
outside React.

Pure helpers for reading and editing models are in `src/state/layout.ts`
(`listPanes`, `findPane`, `frameIdOf`, `removePane`, …). `removePane` relies on
the library's `normalizeWorkspaceModel` to collapse the splits left behind.

## Active pane

The active pane is tracked by the app, not the library: pane content is
rendered through portals, so the library's own "active tabset" does not see
clicks or focus inside a pane. `PaneContent` marks its pane active on focus or
pointer-down (`setActivePane` in the store) and gets the `is-active` class;
CSS in `src/styles/dock.css` styles the frame from that with `:has()`.

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
