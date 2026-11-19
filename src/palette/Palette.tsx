import { Command } from "cmdk";
import { FileText, Layers, PanelsTopLeft, Play, Search, SquareChevronRight } from "lucide-react";
import { Dialog } from "radix-ui";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { chordFromEvent, parseChord, sameChord } from "../commands/keys";
import { allCommands, bindingsOf, isEnabled, recentCommandIds, shortcutLabel } from "../commands/registry";
import { homeDirectory } from "../ipc/system";
import { refocusPane } from "../layout/dock";
import { useAppStore } from "../state/store";
import { type PaletteItem, type PaletteSources, paletteItems } from "./items";
import { closePalette, performPaletteAction, usePalette } from "./state";
import { filesUnder, projectRoot, recentFilePaths } from "./sources";

/*
 * The command palette (⌘K): commands, tabs, workspaces, files and running
 * a shell command, in one fuzzy list. cmdk provides the list behaviour
 * (keyboard selection, accessibility); ranking is ours (`items.ts`), so
 * cmdk's own filtering is off.
 */

const ICONS: Record<PaletteItem["icon"], ReactNode> = {
  command: <SquareChevronRight size={13} />,
  tab: <PanelsTopLeft size={13} />,
  workspace: <Layers size={13} />,
  file: <FileText size={13} />,
  run: <Play size={13} />,
};

function abbreviateHome(path: string): string {
  const home = homeDirectory();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The title with matched characters emphasised. */
function Highlighted({ text, indexes }: { text: string; indexes: readonly number[] }) {
  if (indexes.length === 0) return <>{text}</>;
  const marked = new Set(indexes);
  return (
    <>
      {Array.from(text, (char, index) =>
        marked.has(index) ? (
          <span key={index} className="text-accent-fg">
            {char}
          </span>
        ) : (
          <Fragment key={index}>{char}</Fragment>
        ),
      )}
    </>
  );
}

/** Everything but the file list, read once when the palette opens. */
function staticSources(): Omit<PaletteSources, "files" | "root"> {
  const state = useAppStore.getState();
  return {
    commands: allCommands()
      .filter((command) => !command.hidden && !command.id.startsWith("palette.open") && isEnabled(command))
      .map((command) => ({
        id: command.id,
        title: command.title,
        category: command.category,
        shortcut: shortcutLabel(command.id),
      })),
    tabs: state.workspaces.flatMap((workspace) =>
      workspace.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        active: workspace.id === state.activeWorkspaceId && tab.id === workspace.activeTabId,
      })),
    ),
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      tabCount: workspace.tabs.length,
      active: workspace.id === state.activeWorkspaceId,
    })),
    recentCommands: recentCommandIds(),
    recentFiles: recentFilePaths(),
  };
}

function PaletteBody() {
  const { mode, initialQuery } = usePalette();
  const [query, setQuery] = useState(initialQuery);
  const [base] = useState(staticSources);
  const [root, setRoot] = useState<string | undefined>();
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await projectRoot();
      if (cancelled) return;
      setRoot(found);
      const list = found ? await filesUnder(found) : [];
      if (cancelled) return;
      setFiles(list);
      setLoadingFiles(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(
    () =>
      paletteItems(query, mode, { ...base, root, files }).filter(
        // Until the files are in, a file name would otherwise only match
        // "Run …", and Enter would send it to a shell.
        (item) => !(loadingFiles && item.action.kind === "run" && !query.startsWith("$")),
      ),
    [query, mode, base, root, files, loadingFiles],
  );

  // The best item is selected whenever the list changes (cmdk would keep a
  // stale selection when results arrive late).
  const [selected, setSelected] = useState("");
  useEffect(() => setSelected(items[0]?.key ?? ""), [items]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const list = byGroup.get(item.group) ?? [];
      list.push(item);
      byGroup.set(item.group, list);
    }
    return [...byGroup];
  }, [items]);

  const choose = (item: PaletteItem) => {
    closePalette();
    // After the dialog has closed and handed focus back.
    requestAnimationFrame(() => performPaletteAction(item.action));
  };

  const placeholder = mode === "files" ? "Open a file (> for commands)" : "Run a command or open a file";

  return (
    <Command
      shouldFilter={false}
      loop
      label="Command palette"
      className="flex max-h-[min(460px,calc(100vh-80px))] flex-col"
      value={selected}
      onValueChange={setSelected}
      onKeyDown={(event) => {
        // The palette's own shortcut closes it again.
        const chord = chordFromEvent(event.nativeEvent);
        if (chord && bindingsOf("palette.open").some((spec) => {
          const bound = parseChord(spec);
          return bound !== null && sameChord(bound, chord);
        })) {
          event.preventDefault();
          closePalette();
        }
      }}
    >
      <div className="flex h-10 flex-none items-center gap-2 border-b border-line px-3 text-fg-dim">
        <Search size={14} aria-hidden="true" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent text-input text-fg-bright outline-none placeholder:text-fg-faint"
        />
      </div>
      <Command.List className="palette-list min-h-0 flex-1 overflow-y-auto p-[5px]">
        <Command.Empty className="px-2.5 py-6 text-center text-menu text-fg-dim">
          {loadingFiles && query ? "Searching…" : "No matches"}
        </Command.Empty>
        {groups.map(([group, list]) => (
          <Command.Group key={group} heading={group}>
            {list.map((item) => (
              <Command.Item
                key={item.key}
                value={item.key}
                onSelect={() => choose(item)}
                className="palette-item flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2.5 text-menu text-fg-soft"
              >
                <span className="flex flex-none text-fg-dim">{ICONS[item.icon]}</span>
                <span className="min-w-0 flex-shrink truncate">
                  <Highlighted text={item.title} indexes={item.highlight} />
                </span>
                {item.detail && (
                  <span className="min-w-0 flex-1 truncate text-meta text-fg-dim">{item.detail}</span>
                )}
                {!item.detail && <span className="flex-1" />}
                {item.shortcut && <span className="flex-none font-mono text-micro text-fg-dim">{item.shortcut}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
      <div className="flex h-7 flex-none items-center gap-3 border-t border-line px-3 text-micro text-fg-dim">
        <span className="min-w-0 flex-1 truncate font-mono">{root ? abbreviateHome(root) : "No project folder"}</span>
        <span>↩ open</span>
        <span>&gt; commands</span>
        <span>$ run</span>
      </div>
    </Command>
  );
}

/** Mounted once, in App. */
export function Palette() {
  const open = usePalette((state) => state.open);
  const session = usePalette((state) => state.session);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && closePalette()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content
          data-owns-keyboard
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            refocusPane();
          }}
          className="fixed top-[52px] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg bg-popover shadow-menu outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <PaletteBody key={session} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
