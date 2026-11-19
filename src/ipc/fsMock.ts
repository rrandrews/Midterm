import type { FsEntry, GitCode, GitStatus, ListOptions, WatchEvent, Watcher } from "./fs";

/*
 * Development aid: an in-memory file tree standing in for the backend when
 * the page runs in a plain browser (`bun run dev`). It has a few levels,
 * dotfiles, an ignored directory and some git statuses, so the explorer has
 * something to show. Not used inside Tauri.
 */

export const MOCK_HOME = "/Users/dev";
const ROOT = `${MOCK_HOME}/dev/tauri-term`;

type Node = { dir: boolean; children?: Map<string, Node> };

function tree(spec: Record<string, unknown>): Node {
  const children = new Map<string, Node>();
  for (const [name, value] of Object.entries(spec)) {
    children.set(name, value === null ? { dir: false } : tree(value as Record<string, unknown>));
  }
  return { dir: true, children };
}

const fsRoot = tree({
  Users: {
    dev: {
      ".zshrc": null,
      dev: {
        "tauri-term": {
          ".git": { HEAD: null, index: null },
          ".gitignore": null,
          node_modules: { react: { "index.js": null } },
          "src-tauri": { src: { "main.rs": null, "lib.rs": null }, "Cargo.toml": null },
          src: {
            components: {
              "CommandPalette.tsx": null,
              "Pane.tsx": null,
              "SplitNode.tsx": null,
              "TitleBar.tsx": null,
            },
            hooks: { "useFocus.ts": null },
            store: { "layout.ts": null, "workspaces.ts": null },
            "App.tsx": null,
          },
          "package.json": null,
          "README.md": null,
        },
      },
      Documents: { "notes.md": null },
    },
  },
});

const IGNORED = new Set([`${ROOT}/node_modules`, `${ROOT}/.git`]);
const GIT: Record<string, GitCode> = {
  "src/components/SplitNode.tsx": "M",
  "src/components/TitleBar.tsx": "U",
  "src/store/layout.ts": "M",
};

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function lookup(path: string): Node | undefined {
  let node: Node | undefined = fsRoot;
  for (const part of path.split("/").filter(Boolean)) node = node?.children?.get(part);
  return node;
}

function entry(path: string, node: Node): FsEntry {
  const name = nameOf(path);
  return {
    name,
    path,
    kind: node.dir ? "dir" : "file",
    symlink: false,
    hidden: name.startsWith("."),
    ignored: IGNORED.has(path),
  };
}

const watchers = new Set<(event: WatchEvent) => void>();
function changed(...dirs: string[]): void {
  setTimeout(() => watchers.forEach((notify) => notify({ dirs })), 50);
}

export async function listDir(path: string, { showHidden }: ListOptions): Promise<FsEntry[]> {
  const node = lookup(path);
  if (!node?.dir || !node.children) throw new Error(`Not a directory: ${path}`);
  return [...node.children]
    .map(([name, child]) => entry(`${path === "/" ? "" : path}/${name}`, child))
    .filter((item) => showHidden || !(item.hidden || item.ignored))
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
}

export async function stat(path: string): Promise<FsEntry | null> {
  const node = lookup(path);
  return node ? entry(path, node) : null;
}

export async function create(path: string, kind: "file" | "dir"): Promise<void> {
  const parent = lookup(parentOf(path));
  if (!parent?.children) throw new Error("No such directory");
  if (parent.children.has(nameOf(path))) throw new Error("File exists");
  parent.children.set(nameOf(path), kind === "dir" ? { dir: true, children: new Map() } : { dir: false });
  changed(parentOf(path));
}

export async function rename(from: string, to: string): Promise<void> {
  const node = lookup(from);
  const target = lookup(parentOf(to));
  if (!node || !target?.children) throw new Error("No such file");
  if (target.children.has(nameOf(to))) throw new Error("Destination exists");
  lookup(parentOf(from))?.children?.delete(nameOf(from));
  target.children.set(nameOf(to), node);
  changed(parentOf(from), parentOf(to));
}

export async function trash(paths: string[]): Promise<void> {
  for (const path of paths) lookup(parentOf(path))?.children?.delete(nameOf(path));
  changed(...paths.map(parentOf));
}

export async function gitStatus(path: string): Promise<GitStatus | null> {
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null;
  return { root: ROOT, branch: "main", entries: { ...GIT } };
}

export async function watch(onEvent: (event: WatchEvent) => void): Promise<Watcher> {
  watchers.add(onEvent);
  return { setDirs: () => {}, stop: () => void watchers.delete(onEvent) };
}

/** Where a mock terminal starts, so the explorer has a repository to follow. */
export const MOCK_PROJECT = ROOT;
