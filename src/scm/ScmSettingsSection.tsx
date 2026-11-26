import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { featureProblem, setFeatureProfile } from "../ai/profiles";
import { Tip } from "../components/ui/Tooltip";
import { BUTTON, Group, Row, Select, StackedRow } from "../settings/controls";
import { openSettings } from "../settings/dialogState";
import { useScopedActions, useScopedSettings, useSettingsScope } from "../settings/scope";
import { settingsFor, useSettings } from "../settings/settings";
import {
  COMMIT_PROMPT_SETTING_KEY,
  DEFAULT_COMMIT_PROMPT,
  isCustomCommitPrompt,
  MAX_SYSTEM_PROMPT_CHARS,
  resolveCommitPrompt,
} from "./commitMessage";

/*
 * Settings → Source Control custom section for AI commit message generation:
 * - Select a model from Midterm's saved AI models (`settings.ai.profiles`)
 * - Customize the commit message prompt with a Reset button back to default
 */

export function ScmSettingsSection({ pluginId }: { pluginId: string }) {
  const settings = useScopedSettings((state) => state);
  const scope = useSettingsScope();
  const { updatePluginSettings } = useScopedActions();

  const { profiles, defaultProfile, features } = settings.ai;
  const defaultName = profiles.find((p) => p.id === defaultProfile)?.name ?? "none";
  const choices = profiles.map((p) => ({ value: p.id, label: p.name }));
  const modelProblem = featureProblem("commit", settings);

  const savedPrompt = resolveCommitPrompt(settings);
  const customized = isCustomCommitPrompt(settings);
  const [draft, setDraft] = useState(savedPrompt);

  useEffect(() => {
    setDraft(savedPrompt);
  }, [savedPrompt]);

  const commitDraft = (next: string) => {
    if (next === savedPrompt) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === DEFAULT_COMMIT_PROMPT.trim()) {
      if (customized) {
        updatePluginSettings(pluginId, { [COMMIT_PROMPT_SETTING_KEY]: "" });
      }
      setDraft(DEFAULT_COMMIT_PROMPT);
    } else {
      updatePluginSettings(pluginId, { [COMMIT_PROMPT_SETTING_KEY]: next });
    }
  };

  const resetPrompt = () => {
    const live = scope === undefined ? useSettings.getState() : settingsFor(scope, useSettings.getState().base);
    if (isCustomCommitPrompt(live)) {
      updatePluginSettings(pluginId, { [COMMIT_PROMPT_SETTING_KEY]: "" });
    }
    setDraft(DEFAULT_COMMIT_PROMPT);
  };

  const canReset = customized || draft.trim() !== DEFAULT_COMMIT_PROMPT.trim();
  const promptTooLong = draft.length > MAX_SYSTEM_PROMPT_CHARS;

  return (
    <Group
      title="Commit message generation"
      help="Generates commit messages in Source Control from staged or working-tree diffs using one of your saved AI models (secrets are redacted before sending)."
    >
      <Row
        label="Model"
        help="Choose a saved model from Settings → AI, or follow the default model."
        setting="ai.features.commit"
        hint={
          profiles.length === 0 ? (
            <span className="text-fg-dim">No saved models yet. Add one in Settings → AI.</span>
          ) : modelProblem ? (
            <span className="text-warn">{modelProblem}</span>
          ) : undefined
        }
      >
        {profiles.length === 0 ? (
          <button type="button" className={BUTTON} onClick={() => openSettings("ai")}>
            Open AI settings
          </button>
        ) : (
          <Select
            label="Model for commit messages"
            className="w-56"
            value={features.commit ?? ""}
            options={[{ value: "", label: `Default (${defaultName})` }, ...choices]}
            onChange={(id) => setFeatureProfile("commit", id || null, scope)}
          />
        )}
      </Row>

      <StackedRow
        label="Prompt"
        help="Instructions sent to the model when drafting a commit message."
        setting={`plugins.${pluginId}.settings.${COMMIT_PROMPT_SETTING_KEY}`}
      >
        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Commit message prompt"
            rows={5}
            spellCheck={false}
            value={draft}
            data-escape-local={draft !== savedPrompt ? "" : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitDraft(draft)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                commitDraft(draft);
              } else if (e.key === "Escape" && draft !== savedPrompt) {
                e.stopPropagation();
                setDraft(savedPrompt);
              }
            }}
            className="min-h-[110px] w-full resize-y rounded-[5px] bg-field p-2 font-sans text-ui leading-snug text-fg outline-none select-text placeholder:text-fg-faint shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus:shadow-[inset_0_0_0_1px_var(--color-accent)]"
          />
          <div className="flex items-center justify-between gap-2">
            <span className={`text-micro ${promptTooLong ? "text-warn" : "text-fg-faint"}`}>
              {promptTooLong
                ? `Prompt exceeds ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters (${draft.length.toLocaleString()})`
                : customized
                  ? "Custom prompt active"
                  : "Using default prompt"}
            </span>
            <Tip content="Restore the default commit message prompt" side="left">
              <button
                type="button"
                className={BUTTON}
                disabled={!canReset}
                onMouseDown={(e) => e.preventDefault()}
                onClick={resetPrompt}
              >
                <RotateCcw size={11} />
                <span>Reset to default</span>
              </button>
            </Tip>
          </div>
        </div>
      </StackedRow>
    </Group>
  );
}
