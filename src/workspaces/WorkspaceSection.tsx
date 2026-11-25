import { ArrowRight, RotateCcw, Trash2 } from "lucide-react";
import { selectWorkspace } from "../actions";
import { removeWorkspace } from "../closing";
import { confirm } from "../components/ui/ConfirmDialog";
import { Tip } from "../components/ui/Tooltip";
import { getPlugin } from "../plugins/registry";
import { BUTTON, Block, CommitField, Group, Row } from "../settings/controls";
import { setSettingsScope, useSettingsDialog } from "../settings/dialogState";
import { type SettingsOverrides, AI_OVERRIDABLE, OVERRIDABLE } from "../settings/schema";
import { useEditedWorkspace } from "../settings/scope";
import { DEFAULT_SCOPE, useSettings, workspaceSettings } from "../settings/settings";
import { useAppStore } from "../state/store";
import type { Workspace } from "../state/types";
import { WORKSPACE_ICONS } from "./icons";
import { WorkspaceBadge } from "./WorkspaceBadge";

/*
 * Settings → Workspace (only while a workspace is edited): its name and
 * badge icon, what it overrides (with a way back to the defaults for each),
 * and deleting it.
 */

/** Labels and sections of the overridable settings, for the overview. */
const LABELS: Record<string, readonly [label: string, section: string]> = {
  fontFamily: ["Font", "appearance"],
  fontSize: ["Font size", "appearance"],
  accent: ["Accent", "appearance"],
  theme: ["Theme", "appearance"],
  themeFollowSystem: ["Match system appearance", "appearance"],
  themeLight: ["Light theme", "appearance"],
  themeDark: ["Dark theme", "appearance"],
  iconSet: ["File icons", "appearance"],
  defaultPaneKind: ["New tabs and splits open", "general"],
  defaultTerminal: ["Terminal type", "general"],
  python: ["Python environment", "environment"],
  "ai.suggestions": ["Suggest next commands", "ai"],
  "ai.contextBlocks": ["Context size", "ai"],
  "ai.defaultProfile": ["Default model", "ai"],
  "ai.features": ["Models for features", "ai"],
};

const SECTION_NAMES: Record<string, string> = {
  appearance: "Appearance",
  general: "General",
  environment: "Environment",
  ai: "AI",
};

type OverrideEntry = { path: string; label: string; section: string; where: string };

/** Every setting a workspace overrides, in the order the settings list them. */
export function overrideEntries(overrides: SettingsOverrides): OverrideEntry[] {
  const entries: OverrideEntry[] = [];
  const add = (path: string) => {
    const [label, section] = LABELS[path] ?? [path, "general"];
    entries.push({ path, label, section, where: SECTION_NAMES[section] ?? section });
  };
  for (const key of OVERRIDABLE) if (key in overrides) add(key);
  for (const key of AI_OVERRIDABLE) if (overrides.ai && key in overrides.ai) add(`ai.${key}`);
  for (const [id, entry] of Object.entries(overrides.plugins ?? {})) {
    const plugin = getPlugin(id)?.plugin;
    for (const key of Object.keys(entry.settings)) {
      const field = plugin?.settings?.fields?.find((candidate) => candidate.key === key);
      entries.push({
        path: `plugins.${id}.settings.${key}`,
        label: field?.label ?? key,
        section: `plugin:${id}`,
        where: plugin?.name ?? id,
      });
    }
  }
  return entries;
}

function Identity({ workspace }: { workspace: Workspace }) {
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const active = useAppStore((state) => state.activeWorkspaceId === workspace.id);
  return (
    <Block className="flex items-center gap-3.5 py-3.5">
      <WorkspaceBadge workspace={workspace} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <CommitField
          label="Workspace name"
          className="w-full max-w-72 text-input! font-medium"
          value={workspace.name}
          onCommit={(name) => name.trim() && renameWorkspace(workspace.id, name)}
        />
        <div className="flex h-4 items-center gap-1.5 px-0.5 text-meta text-fg-dim">
          {active ? (
            <>
              <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
              Showing now
            </>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[4px] text-fg-dim outline-none hover:text-fg-bright focus-visible:text-fg-bright"
              onClick={() => selectWorkspace(workspace.id)}
            >
              Switch to this workspace <ArrowRight size={11} />
            </button>
          )}
        </div>
      </div>
    </Block>
  );
}

/** The letter and the icons fill 4 rows of 14 exactly. */
const ICON_CELL =
  "flex h-7 w-full items-center justify-center rounded-[6px] text-fg-mid outline-none transition-colors " +
  "hover:bg-hover hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] " +
  "aria-checked:bg-accent/18 aria-checked:text-accent-fg aria-checked:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_55%,transparent)]";

function IconPicker({ workspace }: { workspace: Workspace }) {
  const setWorkspaceIcon = useAppStore((state) => state.setWorkspaceIcon);
  const initial = workspace.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <Block className="pt-2 pb-3">
      <div className="mb-2 flex h-5 items-center text-ui text-fg-soft">Icon</div>
      <div role="radiogroup" aria-label="Workspace icon" className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1">
        <Tip content="The name’s first letter">
          <button
            type="button"
            role="radio"
            aria-checked={!workspace.icon}
            aria-label="First letter"
            className={`${ICON_CELL} text-ui font-bold`}
            onClick={() => setWorkspaceIcon(workspace.id, undefined)}
          >
            {initial}
          </button>
        </Tip>
        {WORKSPACE_ICONS.map(([name, Icon]) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={workspace.icon === name}
            aria-label={name}
            title={name}
            className={ICON_CELL}
            onClick={() => setWorkspaceIcon(workspace.id, name)}
          >
            <Icon size={14} strokeWidth={1.9} />
          </button>
        ))}
      </div>
    </Block>
  );
}

function Overrides({ workspaceId }: { workspaceId: string }) {
  const overrides = useSettings((state) => workspaceSettings(workspaceId, state.base).overrides);
  const entries = overrideEntries(overrides);
  const clear = (path: string) => useSettings.getState().clearOverride(workspaceId, path);
  return (
    <Group
      title="Overrides"
      help="Settings this workspace sets for itself. Everything else follows the defaults, so changing a default changes it here too. Rows a workspace overrides are marked with a bar in their section."
    >
      {entries.length === 0 ? (
        <Block className="text-meta text-fg-dim">
          None yet: this workspace follows the defaults. Change any setting while this workspace is selected above to give it its own value.
        </Block>
      ) : (
        entries.map((entry) => (
          <Row
            key={entry.path}
            label={
              <button
                type="button"
                className="rounded-[3px] text-left outline-none hover:text-fg-bright hover:underline focus-visible:underline"
                onClick={() => useSettingsDialog.setState({ section: entry.section })}
              >
                {entry.label}
              </button>
            }
            hint={entry.where}
          >
            <button type="button" aria-label={`Use the default ${entry.label}`} className={BUTTON} onClick={() => clear(entry.path)}>
              <RotateCcw size={10} /> Use default
            </button>
          </Row>
        ))
      )}
    </Group>
  );
}

function DangerZone({ workspace }: { workspace: Workspace }) {
  const count = useAppStore((state) => state.workspaces.length);
  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${workspace.name}”?`,
      message: "Its tabs close, and its settings, environment variables and secrets are deleted. This cannot be undone.",
      action: "Delete workspace",
    });
    if (!ok) return;
    await removeWorkspace(workspace.id);
    if (!useAppStore.getState().workspaces.some((candidate) => candidate.id === workspace.id)) {
      setSettingsScope(DEFAULT_SCOPE);
      useSettingsDialog.setState({ section: "general" });
    }
  };
  return (
    <Group title="Danger zone">
      <Row
        label="Delete this workspace"
        hint={count <= 1 ? "The only workspace can’t be deleted." : "Closes its tabs and deletes its settings and secrets."}
      >
        <button
          type="button"
          disabled={count <= 1}
          className={`${BUTTON} text-err! hover:bg-err/15 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-err)_35%,transparent)]`}
          onClick={() => void remove()}
        >
          <Trash2 size={11} /> Delete…
        </button>
      </Row>
    </Group>
  );
}

export function WorkspaceSection() {
  const id = useEditedWorkspace();
  const workspace = useAppStore((state) => state.workspaces.find((candidate) => candidate.id === id));
  if (!workspace) return <div className="text-meta text-fg-dim">This workspace no longer exists.</div>;
  return (
    <>
      <Group>
        <Identity workspace={workspace} />
        <IconPicker workspace={workspace} />
      </Group>
      <Overrides workspaceId={workspace.id} />
      <DangerZone workspace={workspace} />
    </>
  );
}
