import { confirm } from "../components/ui/ConfirmDialog";
import { enabledPlugins, usePluginsVersion } from "../plugins/registry";
import { CLASSIC_TERMINAL } from "../terminal/kinds";
import { BUTTON, Group, Row, Select } from "./controls";
import { useSettings } from "./settings";

/* Settings → General: what new panes open as, and restoring the defaults. */

export function GeneralSection() {
  const settings = useSettings();
  const update = settings.updateSettings;
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
        <Row label="Terminal type">
          <Select
            label="Default terminal"
            className="w-48"
            value={defaultTerminal}
            options={terminals.map((plugin) => ({ value: plugin.id, label: plugin.name }))}
            onChange={(value) => update({ defaultTerminal: value })}
          />
        </Row>
        <Row label="New tabs and splits open">
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
      <Group title="Reset">
        <Row label="Restore all defaults" help="Every setting and keyboard shortcut goes back to its default. Which plugins are enabled is kept.">
          <button
            type="button"
            className={`${BUTTON} hover:text-err`}
            onClick={async () => {
              const ok = await confirm({
                title: "Restore all defaults?",
                message: "Every setting and keyboard shortcut goes back to its default. Which plugins are enabled is kept.",
                action: "Restore defaults",
              });
              if (ok) settings.resetSettings();
            }}
          >
            Restore…
          </button>
        </Row>
      </Group>
    </>
  );
}
