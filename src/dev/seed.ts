import { createLayout, createPane, paneNode, singlePaneLayout } from "../state/layout";
import { createTab, createWorkspace, useAppStore } from "../state/store";

/**
 * Development aid: replaces the app state with the arrangement drawn in the
 * reference mockup (three tabs, the middle one with six panes), for comparing
 * the two side by side. Loaded only by `?mockup` in dev builds.
 */
export function seedMockupLayout(): void {
  const frontend = createLayout({
    type: "split",
    orientation: "horizontal",
    children: [
      paneNode(createPane("explorer"), "220px"),
      {
        type: "split",
        orientation: "vertical",
        children: [
          paneNode(createPane("editor"), 47),
          {
            type: "split",
            orientation: "horizontal",
            children: [paneNode(createPane("terminal")), paneNode(createPane("terminal"), 36)],
          },
        ],
      },
      {
        type: "split",
        orientation: "vertical",
        size: 30,
        children: [paneNode(createPane("viewer"), 44), paneNode(createPane("terminal"))],
      },
    ],
  });

  const tabs = [
    createTab({ title: "server" }),
    createTab({ title: "frontend", layout: frontend }),
    { ...createTab({ title: "logs", layout: singlePaneLayout() }), activity: true },
  ];
  const workspace = { ...createWorkspace("tauri-term", tabs), activeTabId: tabs[1].id };
  useAppStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
}
