import { RotateCcw, Search, TriangleAlert, X } from "lucide-react";
import { Fragment, useState, useSyncExternalStore } from "react";
import { Tip } from "../components/ui/Tooltip";
import { chordFromEvent, chordToString, formatBinding, parseChord } from "../commands/keys";
import { allCommands, bindingsOf, commandsVersion, conflictsWith, subscribeCommands } from "../commands/registry";
import { FIELD, Group, ICON_BUTTON, Row } from "./controls";
import { useSettings } from "./settings";

/*
 * Settings → Keyboard: every command by category, its shortcut shown as
 * key caps. Click a shortcut to record a new one (Escape cancels).
 */

const MODIFIERS = new Set(["⌃", "⌥", "⇧", "⌘"]);

/** "⇧⌘P" → ["⇧", "⌘", "P"]. */
function caps(text: string): string[] {
  const keys: string[] = [];
  let at = 0;
  while (at < text.length && MODIFIERS.has(text[at])) keys.push(text[at++]);
  if (at < text.length) keys.push(text.slice(at));
  return keys;
}

const CAP =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] bg-field px-1 font-sans text-meta leading-none shadow-[inset_0_-1px_0_var(--color-line-strong),inset_0_0_0_1px_var(--color-line-strong)]";

function Keys({ bindings, warn }: { bindings: string[]; warn: boolean }) {
  if (!bindings.length) return <span className="px-1 text-meta text-fg-faint">Not set</span>;
  return (
    <span className={`flex items-center gap-1 ${warn ? "text-warn" : "text-fg-soft"}`}>
      {bindings.map((spec, index) => (
        <Fragment key={spec}>
          {index > 0 && <span className="px-0.5 text-micro text-fg-faint">or</span>}
          <span className="flex items-center gap-[3px]">
            {caps(formatBinding(spec)).map((key, at) => (
              <kbd key={`${key}${at}`} className={CAP}>
                {key}
              </kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Records a chord: the next non-modifier key pressed. Escape cancels. */
function KeyRecorder({ onRecord, onCancel }: { onRecord: (binding: string) => void; onCancel: () => void }) {
  return (
    <input
      autoFocus
      readOnly
      aria-label="Press the new shortcut"
      data-key-recorder
      placeholder="Press keys…"
      className={`${FIELD} w-32 animate-pulse text-center font-mono text-micro! shadow-[inset_0_0_0_1px_var(--color-accent)] placeholder:text-accent-fg`}
      onBlur={onCancel}
      onKeyDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape" && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
          onCancel();
          return;
        }
        const chord = chordFromEvent(event.nativeEvent);
        if (!chord) return;
        const spec = chordToString(chord);
        if (parseChord(spec)) onRecord(spec);
      }}
    />
  );
}

export function KeyboardSection() {
  useSyncExternalStore(subscribeCommands, commandsVersion);
  const setKeybinding = useSettings((state) => state.setKeybinding);
  const overrides = useSettings((state) => state.keybindings);
  const [recording, setRecording] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const commands = allCommands().filter(
    (command) =>
      !query ||
      `${command.category} ${command.title} ${command.id}`.toLowerCase().includes(query) ||
      bindingsOf(command.id).some((spec) => formatBinding(spec).toLowerCase().includes(query)),
  );
  const categories = [...new Set(commands.map((command) => command.category))];

  return (
    <>
      <div className="sticky top-0 z-10 -mx-1 bg-popover px-1 pb-3">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-faint" />
          <input
            aria-label="Filter commands"
            placeholder="Filter by command or key"
            spellCheck={false}
            className={`${FIELD} h-7! w-full pl-7`}
            value={filter}
            data-escape-local={filter ? "" : undefined}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter) {
                event.stopPropagation();
                setFilter("");
              }
            }}
          />
        </div>
      </div>
      {!commands.length && <div className="px-1 py-6 text-center text-meta text-fg-dim">No commands match “{filter.trim()}”.</div>}
      {categories.map((category) => (
        <Group key={category} title={category}>
          {commands
            .filter((command) => command.category === category)
            .map((command) => {
              const bindings = bindingsOf(command.id);
              const conflicts = bindings.flatMap((spec) => {
                const chord = parseChord(spec);
                return chord ? conflictsWith(chord, command.id) : [];
              });
              const overridden = command.id in overrides;
              const conflict = conflicts.length ? `Also bound to ${conflicts.map((other) => other.title).join(", ")}` : null;
              return (
                <Row
                  key={command.id}
                  className="group/key min-h-8! py-1!"
                  label={
                    <span className="flex items-center gap-1.5">
                      {command.title}
                      {overridden && <span className="size-1.5 flex-none rounded-full bg-accent" title="Changed from the default" />}
                    </span>
                  }
                >
                  {conflict && (
                    <span className="flex text-warn" aria-hidden="true">
                      <TriangleAlert size={12} />
                    </span>
                  )}
                  <span className="flex items-center opacity-0 transition-opacity group-hover/key:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`Restore the default shortcut for ${command.title}`}
                      title="Restore default"
                      disabled={!overridden}
                      onClick={() => setKeybinding(command.id, null)}
                      className={`${ICON_BUTTON} size-5!`}
                    >
                      <RotateCcw size={11} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove the shortcut for ${command.title}`}
                      title="Remove shortcut"
                      disabled={bindings.length === 0}
                      onClick={() => setKeybinding(command.id, [])}
                      className={`${ICON_BUTTON} size-5!`}
                    >
                      <X size={12} />
                    </button>
                  </span>
                  {recording === command.id ? (
                    <KeyRecorder
                      onRecord={(spec) => {
                        setKeybinding(command.id, [spec]);
                        setRecording(null);
                      }}
                      onCancel={() => setRecording(null)}
                    />
                  ) : (
                    <Tip content={conflict ?? "Click to change"}>
                      <button
                        type="button"
                        aria-label={`Shortcut for ${command.title}: ${bindings.map(formatBinding).join(" or ") || "none"}${conflict ? `. ${conflict}` : ""}`}
                        onClick={() => setRecording(command.id)}
                        className="flex h-6 min-w-16 items-center justify-end rounded-[5px] px-1 outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]"
                      >
                        <Keys bindings={bindings} warn={!!conflict} />
                      </button>
                    </Tip>
                  )}
                </Row>
              );
            })}
        </Group>
      ))}
    </>
  );
}
