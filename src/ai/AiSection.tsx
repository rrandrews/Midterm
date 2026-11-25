import { useState } from "react";
import { BUTTON, Block, Group, NumberField, Row, Select, Toggle } from "../settings/controls";
import { useScopedActions, useScopedSettings, useSettingsScope } from "../settings/scope";
import { AI_CONTEXT_RANGE } from "../settings/schema";
import { activeTerminal } from "../terminal/blockMode";
import { contextFor } from "./engine";
import { FEATURES, featureProblem, profileFor, setDefaultProfile, setFeatureProfile } from "./profiles";
import { ProblemText, useAgentAdapterProblem } from "./settings/AgentStatus";
import { ProfileList } from "./settings/ProfileList";

/*
 * Settings → AI: the suggestions switches, the model profiles (Models), and
 * which profile each feature uses (Features). Keys are write-only here:
 * they go to the OS keychain and never come back.
 */

function Features() {
  const settings = useScopedSettings((state) => state);
  const scope = useSettingsScope();
  const { profiles, defaultProfile, features } = settings.ai;
  // The agent's CLI profile: whether its ACP adapter is installed (featureProblem stays pure).
  const adapterProblem = useAgentAdapterProblem(profileFor("agent", settings));
  if (!profiles.length) return null;
  const defaultName = profiles.find((p) => p.id === defaultProfile)?.name ?? "none";
  const choices = profiles.map((profile) => ({ value: profile.id, label: profile.name }));
  return (
    <Group title="Features">
      <Row label="Default model" help="Used by every feature that does not pick its own." setting="ai.defaultProfile">
        <Select label="Default model" className="w-56" value={defaultProfile} options={choices} onChange={(id) => setDefaultProfile(id, scope)} />
      </Row>
      {FEATURES.map((feature) => {
        const problem = featureProblem(feature.id, settings) ?? (feature.id === "agent" ? adapterProblem : null);
        return (
          <Row
            key={feature.id}
            label={feature.label}
            help={feature.hint}
            setting="ai.features"
            hint={
              problem ? (
                <span className="text-warn">
                  <ProblemText problem={problem} />
                </span>
              ) : undefined
            }
          >
            <Select
              label={`Model for ${feature.label}`}
              className="w-56"
              value={features[feature.id] ?? ""}
              options={[{ value: "", label: `Default (${defaultName})` }, ...choices]}
              onChange={(id) => setFeatureProfile(feature.id, id || null, scope)}
            />
          </Row>
        );
      })}
    </Group>
  );
}

export function AiSection() {
  const ai = useScopedSettings((s) => s.ai);
  const { updateAi } = useScopedActions();
  const [preview, setPreview] = useState<string | null>(null);

  const showPreview = async () => {
    const paneId = activeTerminal();
    const context = paneId ? await contextFor(paneId) : null;
    setPreview(context ? `System:\n${context.system}\n\n---\n\n${context.prompt}` : "Focus a terminal pane first: the preview is built from its history.");
  };

  return (
    <div>
      <Group
        title="Suggestions"
        help="Suggestions, /cmd and Explain and fix send the focused terminal’s recent commands, cut output, directory, git branch, shell and OS to your chosen model, with secrets redacted. The agent also sends what its tools read; nothing runs without asking, and nothing is sent until you add a model."
      >
        <Row label="Suggest next commands" help="In the block terminal, at an empty prompt of the focused terminal." setting="ai.suggestions">
          <Toggle label="Suggest next commands" checked={ai.suggestions} onChange={(suggestions) => updateAi({ suggestions })} />
        </Row>
        <Row label="Context size" help="Finished commands (with their output) sent with each request." setting="ai.contextBlocks">
          <NumberField
            label="Context size"
            value={ai.contextBlocks}
            min={AI_CONTEXT_RANGE.min}
            max={AI_CONTEXT_RANGE.max}
            integer
            onCommit={(contextBlocks) => updateAi({ contextBlocks })}
          />
        </Row>
        <Row label="Context preview" help="What a request from the focused terminal would send right now.">
          <button type="button" className={BUTTON} onClick={() => void showPreview()}>
            Preview what is sent
          </button>
        </Row>
        {preview !== null && (
          <Block>
            <div className="mb-1 flex items-center justify-between text-meta text-fg-dim">
              <span>Sent for the focused terminal, as it is now:</span>
              <button type="button" className={BUTTON} onClick={() => setPreview(null)}>
                Hide
              </button>
            </div>
            <pre data-ai-preview className="max-h-72 overflow-auto rounded-[5px] bg-field p-2 font-mono text-micro whitespace-pre-wrap text-fg-mid">
              {preview}
            </pre>
          </Block>
        )}
      </Group>

      <ProfileList />

      <Features />
    </div>
  );
}
