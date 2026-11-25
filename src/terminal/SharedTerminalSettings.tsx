import { usePluginSettings } from "../plugins/settings";
import { FieldRows, Group } from "../settings/controls";
import { useScopedActions } from "../settings/scope";
import { CLASSIC_TERMINAL } from "./kinds";
import { TERMINAL_FIELDS } from "./settings";

/**
 * The block terminal's settings section: the terminal settings, which
 * belong to the shell session and are shared with the classic terminal
 * (saved under its entry).
 */
export function SharedTerminalSettings() {
  const values = usePluginSettings(CLASSIC_TERMINAL, TERMINAL_FIELDS);
  const { updatePluginSettings } = useScopedActions();
  return (
    <Group title="Terminal" help="Shared with the classic terminal.">
      <FieldRows
        fields={TERMINAL_FIELDS}
        values={values}
        pluginId={CLASSIC_TERMINAL}
        onChange={(patch) => updatePluginSettings(CLASSIC_TERMINAL, patch)}
      />
    </Group>
  );
}
