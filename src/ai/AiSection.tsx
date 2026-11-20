import { useState } from "react";
import { BUTTON, FIELD, Row, SectionHeading, Toggle } from "../settings/controls";
import { useSettings } from "../settings/settings";
import { AI_CONTEXT_RANGE } from "../settings/schema";
import { activeTerminal } from "../terminal/blockMode";
import { contextFor } from "./engine";
import { FEATURES, featureProblem, setDefaultProfile, setFeatureProfile } from "./profiles";
import { ProfileList } from "./settings/ProfileList";

/*
 * Settings → AI: the suggestions switches, the model profiles (Models), and
 * which profile each feature uses (Features). Keys are write-only here:
 * they go to the OS keychain and never come back.
 */

function Features() {
  const settings = useSettings();
  const { profiles, defaultProfile, features } = settings.ai;
  if (!profiles.length) return <div className="border-b border-line/60 py-2 text-meta text-fg-dim">Add a model above, then choose which features use it.</div>;
  const defaultName = profiles.find((p) => p.id === defaultProfile)?.name ?? "none";
  return (
    <>
      <Row label="Default model" hint="Used by every feature that does not pick its own.">
        <select aria-label="Default model" className={`${FIELD} w-56 pr-6`} value={defaultProfile} onChange={(event) => setDefaultProfile(event.target.value)}>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </Row>
      {FEATURES.map((feature) => {
        const problem = featureProblem(feature.id, settings);
        return (
          <Row key={feature.id} label={feature.label} hint={problem ? <span className="text-warn">{problem}</span> : feature.hint}>
            <select
              aria-label={`Model for ${feature.label}`}
              className={`${FIELD} w-56 pr-6`}
              value={features[feature.id] ?? ""}
              onChange={(event) => setFeatureProfile(feature.id, event.target.value || null)}
            >
              <option value="">Default ({defaultName})</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Row>
        );
      })}
    </>
  );
}

export function AiSection() {
  const ai = useSettings((s) => s.ai);
  const updateAi = useSettings((s) => s.updateAi);
  const [preview, setPreview] = useState<string | null>(null);

  const showPreview = async () => {
    const paneId = activeTerminal();
    const context = paneId ? await contextFor(paneId) : null;
    setPreview(context ? `System:\n${context.system}\n\n---\n\n${context.prompt}` : "Focus a terminal pane first: the preview is built from its history.");
  };

  return (
    <div>
      <div className="mb-3 rounded-[5px] bg-raised px-3 py-2 text-meta text-fg-mid">
        Suggestions and /cmd send the current terminal’s own recent commands (never other terminals’), their output (cut to its start and end), the
        directory, git branch, shell and OS to the model you choose. Values that look like secrets are replaced with [redacted] first. Nothing is sent
        until you add a model, and a suggestion is only ever placed in the input editor, never run.
      </div>

      <SectionHeading>Suggestions</SectionHeading>
      <Row label="Suggest next commands" hint="In the block terminal, at an empty prompt of the focused terminal.">
        <Toggle label="Suggest next commands" checked={ai.suggestions} onChange={(suggestions) => updateAi({ suggestions })} />
      </Row>
      <Row label="Context size" hint="Finished commands (with their output) sent with each request.">
        <input
          aria-label="Context size"
          type="number"
          min={AI_CONTEXT_RANGE.min}
          max={AI_CONTEXT_RANGE.max}
          className={`${FIELD} w-20`}
          value={ai.contextBlocks}
          onChange={(event) => updateAi({ contextBlocks: Number(event.target.value) })}
        />
      </Row>
      <Row label="Context preview" hint="What a request from the focused terminal would send right now.">
        <button type="button" className={BUTTON} onClick={() => void showPreview()}>
          Preview what is sent
        </button>
      </Row>
      {preview !== null && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-meta text-fg-dim">
            <span>Sent for the focused terminal, as it is now:</span>
            <button type="button" className={BUTTON} onClick={() => setPreview(null)}>
              Hide
            </button>
          </div>
          <pre data-ai-preview className="max-h-72 overflow-auto rounded-[5px] bg-field p-2 font-mono text-micro whitespace-pre-wrap text-fg-mid">
            {preview}
          </pre>
        </div>
      )}

      <SectionHeading>Models</SectionHeading>
      <ProfileList />

      <SectionHeading>Features</SectionHeading>
      <Features />
    </div>
  );
}
