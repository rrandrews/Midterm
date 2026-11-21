import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import { confirm } from "../../components/ui/ConfirmDialog";
import { providerInfo } from "../../ipc/ai";
import { Tip } from "../../components/ui/Tooltip";
import { BUTTON, Block, Group, ICON_BUTTON } from "../../settings/controls";
import { AI_PROFILE_LIMIT, type AiProfile } from "../../settings/schema";
import { useSettings } from "../../settings/settings";
import { blankProfile, deleteProfile, deleteWarning, duplicateProfile, profileProblem } from "../profiles";
import { ProfileEditor } from "./ProfileEditor";

/*
 * Settings → AI → Models: one row per model profile, with its editor
 * opened inline under the row (one at a time). A new profile is edited
 * under the list and only added on Save.
 */

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
    <Group
      title="Models"
      actions={
        !editing?.isNew && (
          <button
            type="button"
            className={BUTTON}
            disabled={profiles.length >= AI_PROFILE_LIMIT}
            onClick={() => setEditing({ profile: blankProfile(), isNew: true })}
          >
            <Plus size={12} /> Add model
          </button>
        )
      }
    >
      {profiles.length === 0 && !editing?.isNew && <Block className="text-meta text-fg-dim">No models yet.</Block>}
      {profiles.map((profile) => {
        const problem = profileProblem(profile);
        const open = editing?.profile.id === profile.id;
        return (
          <Fragment key={profile.id}>
            <div data-ai-profile={profile.id} className="settings-row flex min-h-10 items-center gap-3 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-ui text-fg-soft">{profile.name}</span>
                  {profile.id === defaultProfile && <span className="flex-none rounded-[4px] bg-accent-soft px-1 text-micro text-accent-fg">Default</span>}
                </div>
                <div className="truncate text-meta text-fg-dim">{describe(profile)}</div>
              </div>
              {problem ? (
                <span className="min-w-0 max-w-[40%] flex-none truncate text-meta text-warn">{problem}</span>
              ) : (
                <Tip content="Ready">
                  <span aria-label="Ready" className="size-1.5 flex-none rounded-full bg-ok" />
                </Tip>
              )}
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
          </Fragment>
        );
      })}
      {editing?.isNew && <ProfileEditor key={editing.profile.id} initial={editing.profile} isNew onDone={() => setEditing(null)} />}
    </Group>
  );
}
