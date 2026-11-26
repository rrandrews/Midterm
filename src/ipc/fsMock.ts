import {
  SSH_SCHEME,
  formatRemoteLocation,
  isRemotePath,
  parseLocation,
  posixPathOf,
  remoteIdOf,
} from "../files/location";
import { isMockSshConnected } from "./ssh";
import type {
  FileVersion,
  FoundEntries,
  FoundFiles,
  FsEntry,
  GitCode,
  GitStatus,
  ListOptions,
  TextMatch,
  TextFile,
  TextSearch,
  TextSearchEvent,
  TextSearchFile,
  TextSearchOptions,
  WatchEvent,
  Watcher,
  WriteExpect,
  WriteResult,
} from "./fs";

/*
 * Development aid: an in-memory file tree standing in for the backend when
 * the page runs in a plain browser (`bun run dev`). It has a few levels,
 * dotfiles, an ignored directory and some git statuses, so the explorer has
 * something to show, and some file contents for the editor and viewer. Not
 * used inside Tauri.
 */

export const MOCK_HOME = "/Users/dev";
const ROOT = `${MOCK_HOME}/dev/tauri-term`;

type Node = { dir: boolean; children?: Map<string, Node>; content?: string; mtime?: number };

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
          docs: { "logo.svg": null, "data.bin": null },
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

const REMOTE_MOCK_HOME = "/home/demo";
const REMOTE_MOCK_ROOT = `${REMOTE_MOCK_HOME}/app`;
const remoteRoots = new Map<string, Node>();

function createRemoteTree(): Node {
  const root = tree({
    home: {
      demo: {
        ".bashrc": null,
        app: {
          ".git": { HEAD: null, index: null },
          src: { "server.ts": null, "routes.ts": null },
          "README.md": null,
          "config.json": null,
        },
      },
    },
    etc: { hosts: null },
  });
  const set = (p: string, content: string) => {
    const n = lookupIn(root, p);
    if (n) n.content = content;
  };
  set(`${REMOTE_MOCK_ROOT}/README.md`, "# Remote App\n\nRunning on the mock SSH host.\n\nSee [server](src/server.ts).\n");
  set(`${REMOTE_MOCK_ROOT}/src/server.ts`, 'export const port = 8080;\nconsole.log("remote server", port);\n');
  set(`${REMOTE_MOCK_ROOT}/config.json`, '{\n  "env": "production"\n}\n');
  set("/etc/hosts", "127.0.0.1 localhost\n");
  return root;
}

function rootFor(path: string): { tree: Node; remoteId: string | null; posix: string } {
  const parsed = parseLocation(path);
  if (!parsed) throw new Error(`Invalid path: ${path}`);
  if (parsed.kind === "remote") {
    if (!isMockSshConnected(parsed.remoteId)) {
      throw new Error(`SSH connection '${parsed.remoteId}' is not active`);
    }
    let r = remoteRoots.get(parsed.remoteId);
    if (!r) {
      r = createRemoteTree();
      remoteRoots.set(parsed.remoteId, r);
    }
    return { tree: r, remoteId: parsed.remoteId, posix: parsed.path };
  }
  if (path.startsWith(SSH_SCHEME)) throw new Error(`Invalid SSH location: ${path}`);
  return { tree: fsRoot, remoteId: null, posix: posixPathOf(path) };
}

function prefixPath(remoteId: string | null, posix: string): string {
  return remoteId ? formatRemoteLocation(remoteId, posix) : posix;
}

const parentOf = (path: string) => {
  const { remoteId, posix } = rootFor(path);
  const idx = posix.lastIndexOf("/");
  return prefixPath(remoteId, idx <= 0 ? "/" : posix.slice(0, idx));
};
const nameOf = (path: string) => {
  const posix = posixPathOf(path);
  return posix.slice(posix.lastIndexOf("/") + 1);
};

function lookupIn(root: Node, posix: string): Node | undefined {
  let node: Node | undefined = root;
  for (const part of posix.split("/").filter(Boolean)) node = node?.children?.get(part);
  return node;
}

function lookup(path: string): Node | undefined {
  const { tree: root, posix } = rootFor(path);
  return lookupIn(root, posix);
}

const CONTENT: Record<string, string> = {
  "src/components/SplitNode.tsx": `import { Fragment } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { LayoutNode } from "../store/layout";

export function SplitNode({ node }: { node: LayoutNode }) {
  if (node.kind === "leaf") return <Pane id={node.paneId} />;

  return (
    <PanelGroup direction={node.axis} autoSaveId={node.id}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <PanelResizeHandle className="hairline" />}
          <Panel defaultSize={child.size} minSize={8}>
            <SplitNode node={child} />
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
`,
  "README.md": [
    "# tauri-term",
    "",
    "A compact terminal for people who live in splits. Workspaces hold tabs; tabs hold any tree of panes.",
    "",
    "## Pane types",
    "",
    "- **terminal**: blocks or classic, per pane",
    "- **editor** and **viewer**: CodeMirror 6",
    "- **explorer**: follows the focused pane's cwd",
    "",
    "See [the layout code](src/components/SplitNode.tsx) or the [Tauri docs](https://tauri.app).",
    "",
    "![logo](docs/logo.svg)",
    "",
    "```sh",
    "pnpm tauri dev",
    "```",
    "",
  ].join("\n"),
  "package.json": '{\n  "name": "tauri-term",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
  "docs/logo.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#8B9CFF" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 10 3 2-3 2M12 15h5"/></svg>\n',
  "docs/data.bin": "\u0000\u0001binary",
};
for (const [relative, content] of Object.entries(CONTENT)) {
  const node = lookup(`${ROOT}/${relative}`);
  if (node) node.content = content;
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
  const { remoteId, posix } = rootFor(path);
  const node = lookup(path);
  if (!node?.dir || !node.children) throw new Error(`Not a directory: ${path}`);
  return [...node.children]
    .map(([name, child]) => entry(prefixPath(remoteId, `${posix === "/" ? "" : posix}/${name}`), child))
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
  if (remoteIdOf(from) !== remoteIdOf(to)) {
    throw new Error("cannot move entries across different hosts; use Copy instead");
  }
  const node = lookup(from);
  const target = lookup(parentOf(to));
  if (!node || !target?.children) throw new Error("No such file");
  if (target.children.has(nameOf(to))) throw new Error("Destination exists");
  lookup(parentOf(from))?.children?.delete(nameOf(from));
  target.children.set(nameOf(to), node);
  changed(parentOf(from), parentOf(to));
}

export async function trash(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (isRemotePath(path)) {
      throw new Error("remote SSH paths cannot be moved to Trash; use permanent delete instead");
    }
  }
  for (const path of paths) lookup(parentOf(path))?.children?.delete(nameOf(path));
  changed(...paths.map(parentOf));
}

export async function deletePermanent(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (!isRemotePath(path)) throw new Error("fs_delete_permanent only supports remote SSH paths");
    if (posixPathOf(path) === "/") throw new Error("refusing to delete remote filesystem root");
  }
  for (const path of paths) lookup(parentOf(path))?.children?.delete(nameOf(path));
  changed(...paths.map(parentOf));
}

export async function gitStatus(path: string): Promise<GitStatus | null> {
  const { remoteId, posix } = rootFor(path);
  if (remoteId) {
    if (posix !== REMOTE_MOCK_ROOT && !posix.startsWith(`${REMOTE_MOCK_ROOT}/`)) return null;
    return {
      root: formatRemoteLocation(remoteId, REMOTE_MOCK_ROOT),
      branch: "main",
      entries: { "src/server.ts": "M" },
    };
  }
  if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return null;
  return { root: ROOT, branch: "main", entries: { ...GIT } };
}

export async function watch(onEvent: (event: WatchEvent) => void): Promise<Watcher> {
  watchers.add(onEvent);
  return { setDirs: () => {}, stop: () => void watchers.delete(onEvent) };
}

/*
 * File contents. A file without any holds a line naming it.
 */

const START = Date.now();

function fileNode(path: string): Node {
  const node = lookup(path);
  if (!node) throw new Error(`No such file: ${path}`);
  if (node.dir) throw new Error(`Is a directory: ${path}`);
  return node;
}

const contentOf = (path: string, node: Node) => node.content ?? `// ${nameOf(path)}\n`;
const versionOf = (path: string, node: Node): FileVersion => ({
  mtime: String((node.mtime ?? START) * 1_000_000),
  size: new TextEncoder().encode(contentOf(path, node)).length,
});

export async function readTextFile(path: string): Promise<TextFile> {
  const node = fileNode(path);
  const text = contentOf(path, node);
  const version = versionOf(path, node);
  return text.includes("\u0000") ? { kind: "binary", version } : { kind: "text", text, version };
}

export async function readFileBytes(path: string): Promise<ArrayBuffer> {
  return new TextEncoder().encode(contentOf(path, fileNode(path))).buffer as ArrayBuffer;
}

export async function writeTextFile(
  path: string,
  text: string,
  expect: WriteExpect,
): Promise<WriteResult> {
  const existing = lookup(path);
  const current = existing && !existing.dir ? versionOf(path, existing) : null;
  const matches =
    expect.kind === "any" ||
    (expect.kind === "absent"
      ? current === null
      : current?.mtime === expect.version.mtime && current.size === expect.version.size);
  if (!matches) return { kind: "conflict", current };
  const parent = lookup(parentOf(path));
  if (!parent?.children) throw new Error("No such directory");
  const node: Node = existing && !existing.dir ? existing : { dir: false };
  node.content = text;
  node.mtime = Math.max(Date.now(), (existing?.mtime ?? START) + 1);
  parent.children.set(nameOf(path), node);
  changed(parentOf(path));
  return { kind: "written", version: versionOf(path, node) };
}

export async function fileVersion(path: string): Promise<FileVersion | null> {
  const node = lookup(path);
  return node && !node.dir ? versionOf(path, node) : null;
}

/** Where a mock terminal starts, so the explorer has a repository to follow. */
export const MOCK_PROJECT = ROOT;

export async function findFiles(root: string, limit: number): Promise<FoundFiles> {
  const { remoteId, posix } = rootFor(root);
  const paths: string[] = [];
  const walk = (dirPosix: string, prefix: string) => {
    const fullDir = prefixPath(remoteId, dirPosix || "/");
    const node = lookup(fullDir);
    for (const [name, child] of [...(node?.children ?? [])].sort(([a], [b]) => a.localeCompare(b))) {
      const childPosix = `${dirPosix}/${name}`;
      const fullPath = prefixPath(remoteId, childPosix);
      if (name.startsWith(".") || IGNORED.has(fullPath)) continue;
      if (child.dir) walk(childPosix, `${prefix}${name}/`);
      else paths.push(`${prefix}${name}`);
    }
  };
  if (!lookup(root)?.dir) throw new Error(`Not a directory: ${root}`);
  walk(posix === "/" ? "" : posix, "");
  return { paths: paths.slice(0, limit), truncated: paths.length > limit };
}

export async function findEntries(
  root: string,
  { limit, showHidden }: { limit: number; showHidden: boolean },
): Promise<FoundEntries> {
  const { remoteId, posix } = rootFor(root);
  const entries: FoundEntries["entries"] = [];
  const walk = (dirPosix: string, prefix: string) => {
    const fullDir = prefixPath(remoteId, dirPosix || "/");
    const node = lookup(fullDir);
    for (const [name, child] of [...(node?.children ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const childPosix = `${dirPosix}/${name}`;
      const fullPath = prefixPath(remoteId, childPosix);
      if (!showHidden && (name.startsWith(".") || IGNORED.has(fullPath))) continue;
      entries.push({ path: `${prefix}${name}`, dir: child.dir });
      // `.git` is listed, its contents never.
      if (child.dir && name !== ".git") walk(childPosix, `${prefix}${name}/`);
    }
  };
  if (!lookup(root)?.dir) throw new Error(`Not a directory: ${root}`);
  walk(posix === "/" ? "" : posix, "");
  return { entries: entries.slice(0, limit), truncated: entries.length > limit };
}

export async function copyInto(from: string, toDir: string): Promise<string> {
  const node = lookup(from);
  const target = lookup(toDir);
  if (!node) throw new Error(`No such file: ${from}`);
  if (!target?.children) throw new Error(`Not a directory: ${toDir}`);
  if (node.dir && (toDir === from || toDir.startsWith(`${from}/`))) throw new Error(`Cannot copy ${from} into itself`);
  const name = nameOf(from);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 && !node.dir && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let copyName = name;
  for (let n = 2; target.children.has(copyName); n++) copyName = `${stem} copy${n > 2 ? ` ${n - 1}` : ""}${ext}`;
  const clone = (source: Node): Node => ({
    ...source,
    ...(source.children
      ? { children: new Map([...source.children].map(([childName, child]) => [childName, clone(child)])) }
      : {}),
  });
  target.children.set(copyName, clone(node));
  changed(toDir);
  const { remoteId, posix } = rootFor(toDir);
  return prefixPath(remoteId, `${posix === "/" ? "" : posix}/${copyName}`);
}

const WINDOW = 300;

function lineMatches(text: string, test: RegExp): TextMatch | null {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(test)) if (m[0].length > 0) ranges.push([m.index, m.index + m[0].length]);
  const first = ranges[0];
  if (!first) return null;
  const column = first[0] + 1;
  if (text.length <= WINDOW) return { line: 0, column, text, ranges };
  const start = Math.max(0, first[0] - 60);
  const end = Math.min(text.length, start + WINDOW);
  const lead = start > 0 ? 1 : 0;
  return {
    line: 0,
    column,
    text: `${lead ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
    ranges: ranges.filter(([s]) => s < end).map(([s, e]): [number, number] => [Math.max(s, start) - start + lead, Math.min(e, end) - start + lead]),
  };
}

/** Searches the mock tree's file contents (a file without any holds a line naming it) in one batch. */
export async function searchText(
  root: string,
  options: TextSearchOptions,
  onEvent: (event: TextSearchEvent) => void,
): Promise<TextSearch> {
  let cancelled = false;
  setTimeout(() => {
    if (cancelled) return;
    const finish = (event: TextSearchEvent) => onEvent(event);
    if (options.query === "") return finish({ type: "done", truncated: false, cancelled: false, filesSearched: 0 });
    let test: RegExp;
    try {
      const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      test = new RegExp(options.wholeWord ? `\\b(?:${source})\\b` : source, options.caseSensitive ? "gu" : "giu");
    } catch (error) {
      return finish({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    const files: TextSearchFile[] = [];
    let total = 0;
    let truncated = false;
    let searched = 0;
    const { remoteId, posix } = rootFor(root);
    const walk = (dirPosix: string, prefix: string): boolean => {
      const fullDir = prefixPath(remoteId, dirPosix || "/");
      const node = lookup(fullDir);
      for (const [name, child] of [...(node?.children ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const childPosix = `${dirPosix}/${name}`;
        const path = prefixPath(remoteId, childPosix);
        if (!options.showHidden && (name.startsWith(".") || IGNORED.has(path))) continue;
        if (name === ".git") continue;
        if (child.dir) {
          if (!walk(childPosix, `${prefix}${name}/`)) return false;
          continue;
        }
        const content = contentOf(path, child);
        if (content.includes("\u0000")) continue;
        searched++;
        const matches: TextMatch[] = [];
        for (const [index, text] of content.split("\n").entries()) {
          const found = lineMatches(text, test);
          if (!found) continue;
          if (total === options.maxResults) {
            truncated = true;
            break;
          }
          total++;
          matches.push({ ...found, line: index + 1 });
        }
        if (matches.length > 0) files.push({ path: `${prefix}${name}`, matches });
        if (truncated) return false;
      }
      return true;
    };
    if (!lookup(root)?.dir) return finish({ type: "error", message: `Not a directory: ${root}` });
    walk(posix === "/" ? "" : posix, "");
    if (files.length > 0) finish({ type: "files", files });
    finish({ type: "done", truncated, cancelled: false, filesSearched: searched });
  }, 0);
  return { cancel: () => void (cancelled = true) };
}
