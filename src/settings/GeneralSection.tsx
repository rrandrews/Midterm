import { confirm } from "../components/ui/ConfirmDialog";
import { enabledPlugins, usePluginsVersion } from "../plugins/registry";
import { CLASSIC_TERMINAL } from "../terminal/kinds";
import { BUTTON, Group, Row, Select } from "./controls";
import { hasOverrides } from "./schema";
import { useEditedWorkspace, useScopedActions, useScopedSettings } from "./scope";
import { useSettings, workspaceSettings } from "./settings";

/* Settings → General: what new panes open as, and restoring the defaults. */

export function GeneralSection() {
  const settings = useScopedSettings((state) => state);
  const { updateSettings: update, resetSettings } = useScopedActions();
  const workspace = useEditedWorkspace();
  usePluginsVersion();
  const kinds = enabledPlugins();
  const terminals = kinds.filter((plugin) => plugin.terminal);
  const others = kinds.filter((plugin) => !plugin.terminal);
  const defaultTerminal = terminals.some((plugin) => plugin.id === settings.defaultTerminal)
    ? settings.defaultTerminal
    : CLASSIC_TERMINAL;
  // A terminal kind in `defaultPaneKind` means "the default terminal" (stored as the classic id).
  const defaultPane = others.some((plugin) => plugin.id === settings.defaultPaneKind)
    ? settings.defaultPaneKind
    : CLASSIC_TERMINAL;
  return (
    <>
      <Group title="New panes" help="A pane can switch to another type from its menu at any time.">
        <Row label="Terminal type" setting="defaultTerminal">
          <Select
            label="Default terminal"
            className="w-48"
            value={defaultTerminal}
            options={terminals.map((plugin) => ({ value: plugin.id, label: plugin.name }))}
            onChange={(value) => update({ defaultTerminal: value })}
          />
        </Row>
        <Row label="New tabs and splits open" setting="defaultPaneKind">
          <Select
            label="Default pane type"
            className="w-48"
            value={defaultPane}
            options={[
              { value: CLASSIC_TERMINAL, label: "A terminal" },
              ...others.map((plugin) => ({ value: plugin.id, label: plugin.name })),
            ]}
            onChange={(defaultPaneKind) => update({ defaultPaneKind })}
          />
        </Row>
      </Group>
      {workspace ? <ClearOverrides workspace={workspace} onClear={resetSettings} /> : (
        <Group title="Reset">
          <Row label="Restore all defaults" help="Every setting and keyboard shortcut goes back to its default. Which plugins are enabled, environment variables, secrets and workspaces are kept.">
            <button
              type="button"
              className={`${BUTTON} hover:text-err`}
              onClick={async () => {
                const ok = await confirm({
                  title: "Restore all defaults?",
                  message: "Every setting and keyboard shortcut goes back to its default. Which plugins are enabled, environment variables, secrets and workspaces are kept.",
                  action: "Restore defaults",
                });
                if (ok) resetSettings();
              }}
            >
              Restore…
            </button>
          </Row>
        </Group>
      )}
    </>
  );
}

/** In a workspace: drop every override, so it follows the defaults again. */
function ClearOverrides({ workspace, onClear }: { workspace: string; onClear: () => void }) {
  const overrides = useSettings((state) => workspaceSettings(workspace, state.base).overrides);
  const { python: _python, ...settings } = overrides;
  const any = hasOverrides(settings);
  return (
    <Group title="Reset">
      <Row
        label="Use the defaults for everything"
        help="Drops every setting this workspace overrides. Its environment variables, secrets and Python environment are kept."
        hint={any ? undefined : "This workspace uses the defaults."}
      >
        <button
          type="button"
          disabled={!any}
          className={`${BUTTON} hover:text-err`}
          onClick={async () => {
            const ok = await confirm({
              title: "Clear this workspace’s overrides?",
              message: "Every setting it overrides goes back to following the defaults.",
              action: "Clear overrides",
            });
            if (ok) onClear();
          }}
        >
          Clear overrides…
        </button>
      </Row>
    </Group>
  );
}
