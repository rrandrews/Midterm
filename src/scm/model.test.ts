import { beforeEach, describe, expect, it, vi } from "vitest";
import * as scm from "../ipc/scm";
import { resetScmMock } from "../ipc/scmMock";
import { normalizeScmRoot, ScmModel } from "./model";

vi.mock("../components/ui/ConfirmDialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

describe("scm/model", () => {
  beforeEach(() => {
    resetScmMock("/Users/dev/project", true);
  });

  it("loads status, stages/unstages, commits, and undoes commits", async () => {
    const persisted: unknown[] = [];
    const model = new ScmModel("pane-1", { root: "/Users/dev/project" }, (s) => persisted.push(s));
    await model.refresh({ includeMeta: true });

    let snap = model.snapshot();
    expect(snap.notARepo).toBe(false);
    expect(snap.status?.branch).toBe("main");
    expect(snap.status?.staged.length).toBe(1);
    expect(snap.status?.unstaged.length).toBe(2);
    expect(snap.status?.untracked.length).toBe(1);
    expect(snap.branches.length).toBeGreaterThan(0);
    expect(snap.commits.length).toBe(3);

    // Stage one unstaged file
    await model.stage(["README.md"]);
    snap = model.snapshot();
    expect(snap.status?.staged.some((f) => f.path === "README.md")).toBe(true);
    expect(snap.status?.unstaged.some((f) => f.path === "README.md")).toBe(false);

    // Commit staged changes
    model.setCommitMessage("docs: update readme");
    await model.commit();
    snap = model.snapshot();
    expect(snap.commitMessage).toBe("");
    expect(snap.status?.staged.length).toBe(0);
    expect(snap.commits[0].subject).toBe("docs: update readme");

    // Undo last commit restores commit message
    await model.undoLastCommit();
    snap = model.snapshot();
    expect(snap.commitMessage).toBe("docs: update readme");
    expect(snap.commits[0].subject).toBe("feat: add source control panel");

    // Toggle view mode persists
    model.setViewMode("tree");
    expect(model.snapshot().viewMode).toBe("tree");
    expect(persisted.length).toBe(1);

    model.dispose();
  });

  it("handles non-repo directory and initRepo", async () => {
    resetScmMock("/Users/dev/fresh", false);
    const model = new ScmModel("pane-2", { root: "/Users/dev/fresh" }, () => {});
    await model.refresh({ includeMeta: true });
    expect(model.snapshot().notARepo).toBe(true);

    await model.initRepo();
    expect(model.snapshot().notARepo).toBe(false);
    expect(model.snapshot().status?.branch).toBe("main");
    model.dispose();
  });

  it("creates, switches, renames, and deletes branches and pushes/pops stashes", async () => {
    const model = new ScmModel("pane-3", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    await model.checkout("feat/new", { create: true });
    expect(model.snapshot().status?.branch).toBe("feat/new");

    await model.renameBranch("feat/new", "feat/renamed");
    expect(model.snapshot().status?.branch).toBe("feat/renamed");

    await model.checkout("main");
    expect(model.snapshot().status?.branch).toBe("main");

    await model.deleteBranch("feat/renamed");
    expect(model.snapshot().branches.some((b) => b.name === "feat/renamed")).toBe(false);

    const beforeStashes = model.snapshot().stashes.length;
    await model.stashPush("temp wip", { includeUntracked: true });
    expect(model.snapshot().stashes.length).toBe(beforeStashes + 1);

    await model.stashApply(0, true);
    expect(model.snapshot().stashes.length).toBe(beforeStashes);

    model.dispose();
  });

  it("preserves SSH root slash, preserves mutation errors across refresh, and prefills amend from HEAD", async () => {
    expect(normalizeScmRoot("ssh://dev-123456789abc/")).toBe("ssh://dev-123456789abc/");
    expect(normalizeScmRoot("ssh://dev-123456789abc/repo/")).toBe("ssh://dev-123456789abc/repo");
    expect(normalizeScmRoot("/")).toBe("/");
    expect(normalizeScmRoot("/tmp/ dir with space ")).toBe("/tmp/ dir with space ");

    const model = new ScmModel("pane-4", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    // Failed checkout error must remain visible after post-failure refresh.
    await model.checkout("nonexistent-branch");
    expect(model.snapshot().error).toContain("Branch not found");

    // Amend prefill resolves HEAD (matching status.headOid) cleanly.
    model.setCommitMessage("");
    model.setAmend(true);
    expect(model.snapshot().commitMessage).toContain("feat: add source control panel");

    // Targeted hunk patch applies to the exact named file in mock.
    await scm.scmApplyPatch(
      "/Users/dev/project",
      "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
      true,
      false,
    );
    await model.refresh({ includeMeta: false });
    expect(model.snapshot().status?.staged.some((f) => f.path === "README.md")).toBe(true);
    expect(model.snapshot().status?.unstaged.some((f) => f.path === "src/components/Header.tsx")).toBe(true);

    model.dispose();
  });
});
