import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { confirm } from "../../components/ui/ConfirmDialog";
import { providerInfo } from "../../ipc/ai";
import { BUTTON } from "../../settings/controls";
import { AI_PROFILE_LIMIT, type AiProfile } from "../../settings/schema";
import { useSettings } from "../../settings/settings";
import { blankProfile, deleteProfile, deleteWarning, duplicateProfile, profileProblem } from "../profiles";
import { ProfileEditor } from "./ProfileEditor";

/*
 * Settings → AI → Models: one row per model profile, with its editor
 * opened inline under the row (one at a time). A new profile is edited
 * under the list and only added on Save.
 */

const ICON_BUTTON =
  "flex size-6 flex-none items-center justify-center rounded-[5px] text-fg-dim outline-none hover:bg-hover hover:text-fg-bright focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]";

function describe(profile: AiProfile): string {
  const provider = providerInfo(profile.provider)?.name ?? (profile.provider || "No provider");
  const model = profile.model || (providerInfo(profile.provider)?.type === "cli" ? "default model" : "");
  return model ? `${provider} · ${model}` : provider;
}

export function ProfileList() {
  const profiles = useSettings((s) => s.ai.profiles);
  const defaultProfile = useSettings((s) => s.ai.defaultProfile);
  // The profile being edited (by id), or a new one not saved yet.
  const [editing, setEditing] = useState<{ profile: AiProfile; isNew: boolean } | null>(null);

  const remove = async (profile: AiProfile) => {
    const warning = deleteWarning(profile.id);
    if (warning && !(await confirm({ title: "Delete model?", message: `Delete “${profile.name}”? ${warning}`, action: "Delete" }))) return;
    if (editing?.profile.id === profile.id) setEditing(null);
    deleteProfile(profile.id);
  };

  return (
    <div>
      {profiles.length === 0 && !editing?.isNew && (
        <div className="border-b border-line/60 py-2 text-meta text-fg-dim">No models yet. Add one to use the AI features.</div>
      )}
      {profiles.map((profile) => {
        const problem = profileProblem(profile);
        const open = editing?.profile.id === profile.id;
        return (
          <div key={profile.id}>
            <div data-ai-profile={profile.id} className="flex min-h-9 items-center gap-3 border-b border-line/60 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-ui text-fg-soft">{profile.name}</span>
                  {profile.id === defaultProfile && <span className="flex-none text-micro text-fg-dim">default</span>}
                </div>
                <div className="truncate font-mono text-meta text-fg-dim">{describe(profile)}</div>
              </div>
              <span className={`flex-none text-meta ${problem ? "text-warn" : "text-ok"}`}>{problem ?? "Ready"}</span>
              <div className="flex flex-none items-center">
                <button
                  type="button"
                  className={`${ICON_BUTTON} ${open ? "bg-selected text-fg-bright" : ""}`}
                  aria-label={`Edit ${profile.name}`}
                  title="Edit"
                  onClick={() => setEditing(open ? null : { profile, isNew: false })}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className={ICON_BUTTON}
                  aria-label={`Duplicate ${profile.name}`}
                  title="Duplicate"
                  disabled={profiles.length >= AI_PROFILE_LIMIT}
                  onClick={() => duplicateProfile(profile.id)}
                >
                  <Copy size={12} />
                </button>
                <button type="button" className={ICON_BUTTON} aria-label={`Delete ${profile.name}`} title="Delete" onClick={() => void remove(profile)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {open && <ProfileEditor key={profile.id} initial={profile} isNew={false} onDone={() => setEditing(null)} />}
          </div>
        );
      })}
      {editing?.isNew && (
        <div className="pt-2">
          <ProfileEditor key={editing.profile.id} initial={editing.profile} isNew onDone={() => setEditing(null)} />
        </div>
      )}
      {!editing?.isNew && (
        <div className="pt-2">
          <button
            type="button"
            className={`${BUTTON} flex items-center gap-1`}
            disabled={profiles.length >= AI_PROFILE_LIMIT}
            onClick={() => setEditing({ profile: blankProfile(), isNew: true })}
          >
            <Plus size={12} /> Add model
          </button>
        </div>
      )}
    </div>
  );
}
