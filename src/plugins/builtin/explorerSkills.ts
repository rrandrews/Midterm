import { activePaneId, openPaneBeside } from "../../actions";
import { peekExplorer } from "../../explorer/explorers";
import { listDir } from "../../ipc/fs";
import { listPanes } from "../../state/layout";
import { selectActiveTab, useAppStore } from "../../state/store";
import type { Skill } from "../types";

const LIST_LIMIT = 500;

export const explorerSkills: Skill[] = [
  {
    id: "files",
    title: "Browse files",
    description: "List the entries of a directory, and show a file or directory in the file explorer.",
    tools: [
      {
        name: "list_directory",
        description: "Entries of a directory (name, file or dir, size, git-ignored). Hidden and ignored entries only on request.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "Absolute path" },
            showHidden: { type: "boolean", default: false },
          },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path, showHidden = false } = input as { path: string; showHidden?: boolean };
          const entries = await listDir(path, { showHidden });
          return {
            path,
            truncated: entries.length > LIST_LIMIT,
            entries: entries.slice(0, LIST_LIMIT).map((entry) => ({
              name: entry.name,
              kind: entry.kind,
              ignored: entry.ignored,
            })),
          };
        },
      },
      {
        name: "reveal",
        description: "Shows a path in the explorer of the active tab (opening one if there is none) and selects it.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", minLength: 1, description: "Absolute path" } },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path } = input as { path: string };
          // Only the active tab's explorers: one in a background tab would change out of sight.
          const find = () =>
            listPanes(selectActiveTab(useAppStore.getState()).layout)
              .filter((pane) => pane.data.kind === "explorer")
              .map((pane) => peekExplorer(pane.id))
              .find((model) => model !== undefined);
          let model = find();
          if (!model) {
            openPaneBeside("explorer", activePaneId());
            await new Promise((resolve) => setTimeout(resolve, 50));
            model = find();
          }
          if (!model) throw new Error("No explorer could be opened");
          model.reveal(path);
          return { revealed: path };
        },
      },
    ],
  },
];
