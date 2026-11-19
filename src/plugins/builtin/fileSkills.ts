import { activePaneId, livePane, openFile } from "../../actions";
import { peekEditor } from "../../editor/registry";
import { selectAllPanes, useAppStore } from "../../state/store";
import type { Skill, SkillContext } from "../types";

const TEXT_LIMIT = 100_000;

function open(path: string, ctx: SkillContext, line?: number): void {
  const from = ctx.paneId ?? activePaneId();
  if (!from) throw new Error("There is no pane to open the file from");
  openFile(path, { fromPaneId: from, line });
}

/** The editor the agent means: the one named, else the active pane, else the only/first editor. */
function editorPane(paneId: unknown, ctx: SkillContext): string {
  const candidates = [paneId, ctx.paneId, activePaneId()].filter((id): id is string => typeof id === "string");
  for (const id of candidates) if (livePane(id)?.data.kind === "editor") return id;
  if (typeof paneId === "string") throw new Error(`No editor pane "${paneId}"`);
  const first = selectAllPanes(useAppStore.getState()).find((pane) => pane.data.kind === "editor");
  if (!first) throw new Error("There is no editor open");
  return first.id;
}

const pathProperty = { type: "string", minLength: 1, description: "Absolute path" };
const paneIdProperty = { type: "string", description: "An editor pane id; the active editor if omitted" };

export const editorSkills: Skill[] = [
  {
    id: "edit",
    title: "Edit files",
    description: "Open a file in an editor at a line, read the text open in an editor (including unsaved changes), and save it.",
    tools: [
      {
        name: "open_file",
        description: "Opens a file in an editor pane of the active tab, with the cursor on a line if given.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: { path: pathProperty, line: { type: "integer", minimum: 1 } },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input, ctx) => {
          const { path, line } = input as { path: string; line?: number };
          open(path, ctx, line ?? 1);
          return { opened: path, line: line ?? 1 };
        },
      },
      {
        name: "read_open_file",
        description: "The text in an editor as it is now, with unsaved changes, plus its path and whether it is dirty.",
        effect: "read",
        inputSchema: { type: "object", properties: { paneId: paneIdProperty }, additionalProperties: false },
        run: async (input, ctx) => {
          const id = editorPane((input as { paneId?: string }).paneId, ctx);
          const editor = peekEditor(id);
          if (!editor || editor.snapshot().status !== "ready") throw new Error("The editor has no file loaded");
          const text = editor.text();
          return {
            paneId: id,
            path: editor.path,
            dirty: editor.isDirty,
            truncated: text.length > TEXT_LIMIT,
            text: text.slice(0, TEXT_LIMIT),
          };
        },
      },
      {
        name: "save",
        description: "Saves an editor's file (refused if it changed on disk meanwhile).",
        effect: "write",
        inputSchema: { type: "object", properties: { paneId: paneIdProperty }, additionalProperties: false },
        run: async (input, ctx) => {
          const id = editorPane((input as { paneId?: string }).paneId, ctx);
          const editor = peekEditor(id);
          if (!editor || editor.readOnly) throw new Error("Nothing to save");
          const saved = await editor.save();
          if (!saved) throw new Error(editor.snapshot().error ?? "The file was not saved");
          return { saved: editor.path };
        },
      },
    ],
  },
];

export const viewerSkills: Skill[] = [
  {
    id: "view",
    title: "View files",
    description: "Open a Markdown file, an image or other text in a viewer pane.",
    tools: [
      {
        name: "open_file",
        description: "Opens a file in a viewer pane of the active tab (an image or rendered Markdown).",
        effect: "read",
        inputSchema: { type: "object", properties: { path: pathProperty }, required: ["path"], additionalProperties: false },
        run: async (input, ctx) => {
          const { path } = input as { path: string };
          const from = ctx.paneId ?? activePaneId();
          if (!from) throw new Error("There is no pane to open the file from");
          // In a viewer even for text an editor would take.
          openFile(path, { fromPaneId: from, kind: "viewer" });
          return { opened: path };
        },
      },
    ],
  },
];
