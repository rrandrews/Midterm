// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Menu, MenuContent, MenuTrigger } from "../components/ui/Menu";
import { MenuItems } from "./MenuItems";
import type { MenuItemSpec } from "./types";

describe("MenuItems keepOpen and checkSide", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders a right-aligned check mark and keeps the menu open while toggling", async () => {
    let hidden = false;

    function Subject() {
      const [, setTick] = useState(0);
      const items: MenuItemSpec[] = [
        {
          label: "Show hidden files",
          checked: hidden,
          checkSide: "right",
          keepOpen: true,
          run: () => {
            hidden = !hidden;
          },
        },
      ];
      return createElement(
        Menu,
        { defaultOpen: true },
        createElement(MenuTrigger, { asChild: true }, createElement("button", { type: "button" }, "Open")),
        createElement(
          MenuContent,
          { "aria-label": "Test" },
          createElement(MenuItems, { items, onRefresh: () => setTick((n) => n + 1) }),
        ),
      );
    }

    flushSync(() => root.render(createElement(Subject)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const item = () => document.body.querySelector<HTMLElement>('[role="menuitemcheckbox"]');
    expect(item()).not.toBeNull();
    expect(item()!.getAttribute("aria-checked")).toBe("false");

    // Label sits before the check slot when checkSide is "right".
    const children = [...item()!.children];
    expect(children[0].textContent).toBe("Show hidden files");
    expect(children[children.length - 1].querySelector("svg")).toBeNull();

    // Clicking toggles the state, renders the right check mark, and keeps the menu open.
    flushSync(() => item()!.click());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hidden).toBe(true);
    expect(item()).not.toBeNull();
    expect(item()!.getAttribute("aria-checked")).toBe("true");
    const afterChildren = [...item()!.children];
    expect(afterChildren[0].textContent).toBe("Show hidden files");
    expect(afterChildren[afterChildren.length - 1].querySelector("svg")).not.toBeNull();

    // Clicking a second time turns it back off while still open.
    flushSync(() => item()!.click());
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hidden).toBe(false);
    expect(item()).not.toBeNull();
    expect(item()!.getAttribute("aria-checked")).toBe("false");
  });

  it("renders mutually exclusive checked items as menuitemradio with check mark on the left", async () => {
    const items: MenuItemSpec[] = [
      { label: "Last focused terminal", checked: true, run: () => {} },
      { label: "None", checked: false, run: () => {} },
    ];
    flushSync(() =>
      root.render(
        createElement(
          Menu,
          { defaultOpen: true },
          createElement(MenuTrigger, { asChild: true }, createElement("button", { type: "button" }, "Open")),
          createElement(MenuContent, { "aria-label": "Link" }, createElement(MenuItems, { items })),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const radios = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].children[0].querySelector("svg")).not.toBeNull();
    expect(radios[1].getAttribute("aria-checked")).toBe("false");
    expect(radios[1].children[0].querySelector("svg")).toBeNull();
  });
});
