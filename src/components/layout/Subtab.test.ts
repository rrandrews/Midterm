// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { TabRenderProps } from "react-resizable-panels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../../state/types";

const renameSubtab = vi.fn();
const refocusPane = vi.fn();

vi.mock("../../actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../actions")>();
  return {
    ...actual,
    renameSubtab: (...args: unknown[]) => renameSubtab(...args),
  };
});

vi.mock("../../layout/dock", () => ({
  focusPane: vi.fn(),
  notePaneFocused: vi.fn(),
  refocusPane: (...args: unknown[]) => refocusPane(...args),
}));

vi.mock("./PaneMenuItems", () => ({
  PaneMenuItems: () => null,
}));

const { registerPlugin, unregisterPlugin } = await import("../../plugins/registry");
const { Subtab } = await import("./Subtab");

describe("Subtab rename popover", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    renameSubtab.mockReset();
    refocusPane.mockReset();
    registerPlugin(
      {
        id: "test-icon-only",
        name: "Files",
        icon: "folder-tree",
        pane: { subtabIconOnly: true },
      },
      { type: "builtin" },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    unregisterPlugin("test-icon-only");
  });

  function renderSubtab(pane: PaneNode, refSpy = vi.fn()) {
    const props: TabRenderProps = {
      id: `tab-${pane.id}`,
      role: "tab",
      tabIndex: 0,
      "aria-selected": true,
      "aria-controls": `panel-${pane.id}`,
      ref: refSpy,
      onClick: vi.fn(),
    };
    flushSync(() => {
      root.render(createElement(Subtab, { pane, props }));
    });
    return { refSpy };
  }

  it("keeps the icon-only subtab DOM node mounted and opens a portaled rename input on double-click", () => {
    const pane: PaneNode = { id: "p1", data: { kind: "test-icon-only" } };
    const { refSpy } = renderSubtab(pane);

    const tabEl = container.querySelector<HTMLDivElement>(".subtab");
    expect(tabEl).not.toBeNull();
    expect(tabEl?.classList.contains("is-icon-only")).toBe(true);
    expect(refSpy).toHaveBeenCalledWith(tabEl);

    flushSync(() => {
      tabEl!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    // Anchor must remain connected and identical (not replaced when Tip disables).
    const tabAfter = container.querySelector<HTMLDivElement>(".subtab");
    expect(tabAfter).toBe(tabEl);
    expect(tabEl?.isConnected).toBe(true);
    expect(tabEl?.classList.contains("is-renaming")).toBe(true);

    // Popover renders outside the 28px subtab in document.body.
    const popover = document.body.querySelector<HTMLElement>(".subtab-rename-popover");
    expect(popover).not.toBeNull();
    expect(tabEl?.contains(popover!)).toBe(false);

    const input = popover!.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("Files");

    // Edit and commit with Enter.
    input!.value = "Project Files";
    flushSync(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(renameSubtab).toHaveBeenCalledWith("p1", "Project Files");
    expect(refocusPane).toHaveBeenCalled();
    expect(document.body.querySelector(".subtab-rename-popover")).toBeNull();
  });

  it("cancels without committing when Escape is pressed", () => {
    const pane: PaneNode = { id: "p2", data: { kind: "test-icon-only" } };
    renderSubtab(pane);

    const tabEl = container.querySelector<HTMLDivElement>(".subtab")!;
    flushSync(() => {
      tabEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = document.body.querySelector<HTMLInputElement>(".subtab-rename-popover input")!;
    input.value = "Discarded";
    flushSync(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(renameSubtab).not.toHaveBeenCalled();
    expect(refocusPane).toHaveBeenCalled();
    expect(document.body.querySelector(".subtab-rename-popover")).toBeNull();
  });

  it("keeps focus in the rename input when opened from the context menu", async () => {
    const pane: PaneNode = { id: "p3", data: { kind: "test-icon-only" } };
    renderSubtab(pane);

    const tabEl = container.querySelector<HTMLDivElement>(".subtab")!;
    flushSync(() => {
      tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const item = document.body.querySelector<HTMLElement>('[role="menuitem"]');
    expect(item?.textContent).toContain("Rename subtab");
    item!.focus();
    flushSync(() => {
      item!.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const popover = document.body.querySelector<HTMLElement>(".subtab-rename-popover");
    expect(popover?.getAttribute("aria-label")).toBe("Rename subtab");
    const input = popover?.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("keeps the tab DOM element mounted when a non-icon-only title crosses 24 characters", () => {
    registerPlugin(
      {
        id: "test-text-tab",
        name: "Short",
        icon: "square-terminal",
        pane: {},
      },
      { type: "builtin" },
    );
    try {
      renderSubtab({ id: "p4", title: "short", data: { kind: "test-text-tab" } });
      const before = container.querySelector<HTMLDivElement>(".subtab");
      renderSubtab({ id: "p4", title: "a title that is much longer than twenty four characters", data: { kind: "test-text-tab" } });
      const after = container.querySelector<HTMLDivElement>(".subtab");
      expect(after).toBe(before);
    } finally {
      unregisterPlugin("test-text-tab");
    }
  });
});
