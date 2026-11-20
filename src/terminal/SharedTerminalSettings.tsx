import { usePluginSettings } from "../plugins/settings";
import { FieldRows } from "../settings/controls";
import { useSettings } from "../settings/settings";
import { CLASSIC_TERMINAL } from "./kinds";
import { TERMINAL_FIELDS } from "./settings";

/**
 * The block terminal's settings section: the terminal settings, which
 * belong to the shell session and are shared with the classic terminal
 * (saved under its entry).
 */
export function SharedTerminalSettings() {
  const values = usePluginSettings(CLASSIC_TERMINAL, TERMINAL_FIELDS);
  return (
    <>
      <div className="py-2 text-meta text-fg-dim">Shared with the classic terminal.</div>
      <FieldRows
        fields={TERMINAL_FIELDS}
        values={values}
        onChange={(patch) => useSettings.getState().updatePluginSettings(CLASSIC_TERMINAL, patch)}
      />
    </>
  );
}
