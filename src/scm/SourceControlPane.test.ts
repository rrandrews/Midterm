// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetScmMock } from "../ipc/scmMock";
import { validateSourceControlData } from "../plugins/builtin/data";
import { createPaneContext } from "../plugins/PaneHost";
import { ScmDiffPane } from "./DiffView";
import { SourceControlPane } from "./SourceControlPane";

vi.mock("../components/ui/ConfirmDialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("SourceControlPane and ScmDiffPane", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    resetScmMock("/Users/dev/project", true);
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
  });

  it("renders sidebar sections, toggles tree view, and never uses native title attributes", async () => {
    const root = createRoot(host);
    const ctx = createPaneContext("scm-test-1", "source-control");
    await act(async () => {
      root.render(
        createElement(SourceControlPane, {
          paneId: "scm-test-1",
          data: { kind: "source-control", root: "/Users/dev/project" },
          active: true,
          ctx,
        }),
      );
    });
    await flush();

    expect(host.textContent).toContain("Staged Changes");
    expect(host.textContent).toContain("Changes");
    expect(host.textContent).toContain("Graph");
    expect(host.textContent).toContain("Stashes");
    expect(host.textContent).toContain("Header.tsx");
    expect(host.textContent).toContain("main");

    // Verify resize separators exist between Changes, Graph, and Stashes.
    const sashes = host.querySelectorAll('[role="separator"][aria-orientation="horizontal"]');
    expect(sashes.length).toBe(2);

    // Verify graph title rows omit "ago" and local branch badges (head/branch) while keeping tags/remotes.
    const commitRows = Array.from(host.querySelectorAll<HTMLButtonElement>(".scm-commit-row"));
    expect(commitRows.length).toBe(3);
    expect(commitRows[0].textContent).not.toContain("ago");
    expect(commitRows[0].textContent).not.toContain("main");
    expect(commitRows[1].textContent).toContain("v0.9.0");
    expect(commitRows[1].textContent).toContain("origin/main");

    // Expanding a commit preserves the graph rail via `.scm-graph-continuation`.
    await act(async () => {
      commitRows[0].click();
    });
    await flush();
    expect(host.querySelector(".scm-graph-continuation svg line")).not.toBeNull();
    expect(host.querySelector(".scm-commit-details")?.textContent).toContain("main");

    // Verify Midterm's tooltip policy: zero native HTML `title` attributes.
    expect(host.querySelectorAll("[title]").length).toBe(0);

    // Toggle to tree view.
    const viewBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Switch to tree view"]');
    expect(viewBtn).not.toBeNull();
    await act(async () => {
      viewBtn!.click();
    });
    expect(host.querySelector('button[aria-label="Switch to list view"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Stage folder src/components"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Stage folder src/scm"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("renders ScmDiffPane in unified and split modes with hunk actions and zero native titles", async () => {
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ScmDiffPane, {
          paneId: "scm-diff-1",
          target: {
            root: "/Users/dev/project",
            filePath: "src/components/Header.tsx",
            mode: "unstaged",
          },
        }),
      );
    });
    await flush();

    expect(host.textContent).toContain("Header.tsx");
    expect(host.textContent).toContain("Working Tree");
    expect(host.textContent).toContain("Stage Hunk");
    expect(host.textContent).toContain("Revert");
    expect(host.querySelectorAll("[title]").length).toBe(0);

    // Switch to side-by-side split view.
    const splitBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Side-by-side diff"]');
    expect(splitBtn).not.toBeNull();
    await act(async () => {
      splitBtn!.click();
    });
    expect(splitBtn!.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll("colgroup").length).toBe(1);

    await act(async () => {
      root.unmount();
    });
  });

  it("validates saved source-control pane data strictly", () => {
    expect(
      validateSourceControlData({
        root: "/repo",
        pinned: true,
        viewMode: "tree",
        diffTarget: { root: "/repo", filePath: "a.ts", mode: "staged", oldPath: "old.ts" },
      }),
    ).toEqual({
      root: "/repo",
      pinned: true,
      viewMode: "tree",
      diffTarget: { root: "/repo", filePath: "a.ts", mode: "staged", oldPath: "old.ts" },
    });

    expect(
      validateSourceControlData({
        viewMode: "bogus",
        diffTarget: { root: "/repo", filePath: "a.ts", mode: "invalid" },
      }),
    ).toEqual({});
  });
});
