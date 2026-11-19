import type { SettingField } from "../plugins/fields";
import { pluginSettings } from "../plugins/settings";
import type { EditorOptions } from "./model";

/* The editor and viewer plugins' settings (saved under `settings.plugins.<id>.settings`). */

export const EDITOR_FIELDS: SettingField[] = [
  { key: "wordWrap", type: "toggle", label: "Word wrap", hint: "Long lines wrap instead of scrolling sideways", default: false },
  { key: "tabSize", type: "number", label: "Tab size", hint: "Columns a tab character takes", min: 1, max: 16, integer: true, default: 4 },
  { key: "lineNumbers", type: "toggle", label: "Line numbers", default: true },
];

export function editorOptions(): EditorOptions {
  return pluginSettings("editor", EDITOR_FIELDS) as EditorOptions;
}

export const VIEWER_FIELDS: SettingField[] = [
  {
    key: "markdown",
    type: "select",
    label: "Open Markdown",
    hint: "How viewers show .md files",
    options: [
      { value: "rendered", label: "Rendered" },
      { value: "source", label: "As source" },
    ],
    default: "rendered",
  },
];

export function markdownMode(): "rendered" | "source" {
  return pluginSettings("viewer", VIEWER_FIELDS).markdown as "rendered" | "source";
}
