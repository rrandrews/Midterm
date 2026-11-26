import { useEffect, useRef } from "react";
import { shortcutLabel } from "../commands/registry";
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from "../components/ui/Menu";
import type { MenuItemSpec } from "./types";

/** Runs after the menu has closed and handed focus back to the pane, so a panel opened by `run` keeps it. */
const later = (run: () => unknown) =>
  setTimeout(() => {
    try {
      const result = run();
      if (result instanceof Promise) result.catch((error) => console.error("Menu item failed:", error));
    } catch (error) {
      console.error("Menu item failed:", error);
    }
  }, 0);

/** Drops leading, trailing and doubled separators. */
function tidy(items: MenuItemSpec[]): MenuItemSpec[] {
  const result: MenuItemSpec[] = [];
  for (const item of items) {
    if (item.type === "separator" && (result.length === 0 || result[result.length - 1].type === "separator")) continue;
    result.push(item);
  }
  while (result.length && result[result.length - 1].type === "separator") result.pop();
  return result;
}

/** Renders declarative menu items (a plugin's right-click items) in a dropdown or context menu. */
export function MenuItems({ items }: { items: MenuItemSpec[] }) {
  // A highlighted item that unmounts with the menu gets no blur: end its highlight here.
  const highlighted = useRef<((on: boolean) => void) | null>(null);
  useEffect(() => () => highlighted.current?.(false), []);
  const highlight = (item: MenuItemSpec, on: boolean) => {
    if (item.type === "separator" || item.type === "submenu" || !item.onHighlight) return;
    highlighted.current = on ? item.onHighlight : null;
    try {
      item.onHighlight(on);
    } catch (error) {
      console.error("Menu item highlight failed:", error);
    }
  };
  return (
    <>
      {tidy(items).map((item, index) => {
        if (item.type === "separator") return <MenuSeparator key={index} />;
        if (item.type === "submenu") {
          return (
            <MenuSub key={index}>
              <MenuSubTrigger>{item.label}</MenuSubTrigger>
              <MenuSubContent>
                <MenuItems items={item.items} />
              </MenuSubContent>
            </MenuSub>
          );
        }
        return (
          <MenuItem
            key={index}
            checked={item.checked}
            disabled={item.disabled}
            shortcut={item.shortcut ?? (item.commandId ? shortcutLabel(item.commandId) : undefined)}
            onSelect={() => later(item.run)}
            onFocus={item.onHighlight && (() => highlight(item, true))}
            onBlur={item.onHighlight && (() => highlight(item, false))}
          >
            {item.label}
          </MenuItem>
        );
      })}
    </>
  );
}
