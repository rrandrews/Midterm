import { describe, expect, it } from "vitest";
import { MOCK_HOME, MOCK_PROJECT } from "../ipc/fsMock";
import * as fs from "../ipc/fs";
import { _resetMockSshForTests } from "../ipc/ssh";
import { _resetConnectionsForTests, registerConnection } from "../ssh/connections";
import { ExplorerModel, type ExplorerSettings } from "./model";

/*
 * The model against the in-memory tree of src/ipc/fsMock.ts (tests run
 * outside Tauri). Each test file has its own copy of the mock, but tests in
 * this file share it, so those that change it use their own folders.
 */

const P = MOCK_PROJECT;
const src = `${P}/src`;

/** Settles pending listings. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function model(initial: Partial<ExplorerSettings> = {}): Promise<{ model: ExplorerModel; saved: ExplorerSettings[] }> {
  const saved: ExplorerSettings[] = [];
  const explorer = new ExplorerModel("pane-1", { root: P, ...initial }, (settings) => saved.push(settings));
  explorer.attach();
  await settle();
  await settle();
  return { model: explorer, saved };
}

const entryPaths = (explorer: ExplorerModel) =>
  explorer.snapshot().rows.flatMap((row) => (row.type === "entry" ? [row.entry.path] : []));

describe("selection", () => {
  it("selects one entry, toggles with ⌘ and ranges with ⇧", async () => {
    const { model: explorer } = await model();
    const [a, b, c, d] = entryPaths(explorer);
    explorer.select(a);
    expect([...explorer.snapshot().selection]).toEqual([a]);
    explorer.toggleSelected(c);
    expect(new Set(explorer.snapshot().selection)).toEqual(new Set([a, c]));
    expect(explorer.snapshot().selected).toBe(c);
    // The range runs from the anchor (the last ⌘-clicked entry).
    explorer.selectRange(d);
    expect(new Set(explorer.snapshot().selection)).toEqual(new Set([c, d]));
    explorer.selectRange(b, true);
    expect(new Set(explorer.snapshot().selection)).toEqual(new Set([b, c, d]));
    explorer.toggleSelected(c);
    expect(explorer.snapshot().selection.has(c)).toBe(false);
    explorer.select(null);
    expect(explorer.snapshot().selection.size).toBe(0);
  });

  it("leaves out entries inside a selected folder, and deselects what a collapse hides", async () => {
    const { model: explorer } = await model({ expanded: [src] });
    const app = `${src}/App.tsx`;
    explorer.select(src);
    explorer.toggleSelected(app);
    expect(explorer.selectedPaths()).toEqual([src]);
    explorer.collapse(src);
    expect([...explorer.snapshot().selection]).toEqual([src]);
    expect(explorer.snapshot().selected).toBe(src);
  });

  it("selects every entry shown", async () => {
    const { model: explorer } = await model();
    explorer.selectAll();
    expect(explorer.snapshot().selection.size).toBe(entryPaths(explorer).length);
  });

  it("targets the cursor's folder for new and pasted entries", async () => {
    const { model: explorer } = await model({ expanded: [src] });
    expect(explorer.targetDir()).toBe(P);
    explorer.select(`${src}/App.tsx`);
    expect(explorer.targetDir()).toBe(src);
    explorer.select(`${src}/hooks`);
    expect(explorer.targetDir()).toBe(`${src}/hooks`);
  });
});

describe("linking", () => {
  it("links to a pane, unpinning; pinning ends the link", async () => {
    const { model: explorer, saved } = await model({ pinned: true });
    explorer.setLink("term-1");
    expect(explorer.snapshot()).toMatchObject({ link: "term-1", pinned: false });
    explorer.setPinned(true);
    expect(explorer.snapshot()).toMatchObject({ link: null, pinned: true });
    expect(saved[saved.length - 1]).toMatchObject({ link: null, pinned: true });
  });
});

describe("transfer", () => {
  it("moves entries into a folder, keeping open folders open and selecting what arrived", async () => {
    await fs.create(`${P}/move-a`, "dir");
    await fs.create(`${P}/move-a/inner`, "dir");
    await fs.create(`${P}/move-b`, "dir");
    const { model: explorer } = await model({ expanded: [`${P}/move-a`, `${P}/move-a/inner`] });
    const { moves } = await explorer.transfer([`${P}/move-a`], `${P}/move-b`, "move");
    expect(moves).toEqual([{ from: `${P}/move-a`, to: `${P}/move-b/move-a` }]);
    expect(await fs.stat(`${P}/move-b/move-a/inner`)).not.toBeNull();
    expect(explorer.isExpanded(`${P}/move-b`)).toBe(true);
    expect(explorer.isExpanded(`${P}/move-b/move-a/inner`)).toBe(true);
    expect([...explorer.snapshot().selection]).toEqual([`${P}/move-b/move-a`]);
  });

  it("skips moves that go nowhere and refuses a folder into itself", async () => {
    await fs.create(`${P}/self`, "dir");
    const { model: explorer } = await model();
    expect(await explorer.transfer([`${P}/self`], P, "move")).toEqual({ moves: [], failed: [] });
    expect(await explorer.transfer([`${P}/self`], `${P}/self`, "move")).toEqual({ moves: [], failed: [`${P}/self`] });
    expect(explorer.snapshot().error).toMatch(/inside itself/);
  });

  it("keeps its selection when entries go to a folder outside its tree", async () => {
    await fs.create(`${P}/away.txt`, "file");
    const { model: explorer } = await model();
    explorer.select(`${P}/README.md`);
    await explorer.transfer([`${P}/away.txt`], `${MOCK_HOME}/Documents`, "move");
    expect(await fs.stat(`${MOCK_HOME}/Documents/away.txt`)).not.toBeNull();
    expect(explorer.selectedPaths()).toEqual([`${P}/README.md`]);
  });

  it("selects only a newly created entry", async () => {
    const { model: explorer } = await model();
    explorer.select(`${P}/README.md`);
    explorer.startCreate(P, "dir");
    await explorer.commitCreate("made-here");
    expect([...explorer.snapshot().selection]).toEqual([`${P}/made-here`]);
    expect(explorer.selectedPaths()).toEqual([`${P}/made-here`]);
  });

  it("copies next to the original with a free name", async () => {
    await fs.create(`${P}/dup.txt`, "file");
    const { model: explorer } = await model();
    await explorer.duplicate([`${P}/dup.txt`]);
    expect(await fs.stat(`${P}/dup copy.txt`)).not.toBeNull();
    expect(explorer.snapshot().selected).toBe(`${P}/dup copy.txt`);
    await explorer.transfer([`${P}/dup.txt`], P, "copy");
    expect(await fs.stat(`${P}/dup copy 2.txt`)).not.toBeNull();
  });
});

describe("remote ssh explorer", () => {
  it("lists, reveals, copies across hosts, and permanently deletes remote SSH entries", async () => {
    _resetConnectionsForTests();
    _resetMockSshForTests();
    const rid = "prod-0123456789ab";
    await registerConnection({
      id: rid,
      label: "prod",
      host: "10.0.0.5",
      user: "demo",
      port: 22,
      controlPath: "/tmp/mt-501/s-0123456789ab",
      ownedSocket: true,
      sshArgs: ["--", "prod"],
    });

    const remoteRoot = `ssh://${rid}/home/demo/app`;
    const saved: ExplorerSettings[] = [];
    // Non-canonical trailing slashes on root must canonicalize and never hang reveal().
    const explorer = new ExplorerModel("pane-ssh", { root: `${remoteRoot}///` }, (s) => saved.push(s));
    explorer.attach();
    await settle();
    await settle();

    expect(explorer.rootPath).toBe(remoteRoot);
    expect(entryPaths(explorer)).toContain(`${remoteRoot}/README.md`);
    expect(explorer.snapshot().branch).toBe("main");
    expect(explorer.snapshot().badges.get(`${remoteRoot}/src/server.ts`)).toBe("M");

    // Reveal expands remote ancestors cleanly.
    explorer.reveal(`${remoteRoot}/src/server.ts`);
    await settle();
    await settle();
    expect(explorer.isExpanded(`${remoteRoot}/src`)).toBe(true);
    expect(explorer.snapshot().selected).toBe(`${remoteRoot}/src/server.ts`);

    // Cross-host copy (local -> remote) succeeds; cross-host move fails cleanly.
    await fs.create(`${P}/upload-me.txt`, "file");
    const copyRes = await explorer.transfer([`${P}/upload-me.txt`], remoteRoot, "copy");
    expect(copyRes.failed).toEqual([]);
    expect(await fs.stat(`${remoteRoot}/upload-me.txt`)).not.toBeNull();

    const moveRes = await explorer.transfer([`${P}/upload-me.txt`], remoteRoot, "move");
    expect(moveRes.failed).toEqual([`${P}/upload-me.txt`]);
    expect(explorer.snapshot().error).toMatch(/different hosts|Copy/);

    // Permanent delete removes remote entry and refreshes.
    expect(await explorer.deletePermanent([`${remoteRoot}/upload-me.txt`])).toBe(true);
    expect(await fs.stat(`${remoteRoot}/upload-me.txt`)).toBeNull();

    // Reveal at remote root ssh://<id>/// terminates safely without looping.
    explorer.setRoot(`ssh://${rid}///`);
    await settle();
    explorer.reveal(`ssh://${rid}/etc/hosts`);
    await settle();
    expect(explorer.rootPath).toBe(`ssh://${rid}/`);
    expect(explorer.isExpanded(`ssh://${rid}/etc`)).toBe(true);

    explorer.dispose();
  });
});
