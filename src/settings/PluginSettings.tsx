import { MoreHorizontal, Plus } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../components/ui/Menu";
import { revealInFileManager } from "../ipc/shell";
import { pluginsDirectory } from "../ipc/plugins";
import { importPluginInteractively, refreshInstalled, removePluginInteractively, useInstalledPlugins } from "../plugins/loader";
import {
  type RegisteredPlugin,
  allPlugins,
  getPlugin,
  isPluginEnabled,
  loadErrorIds,
  loadErrorOf,
  usePluginsVersion,
} from "../plugins/registry";
import { usePluginSettings } from "../plugins/settings";
import { allSkills, setSkillEnabled, skillProblems, skillsVersion, subscribeSkills } from "../plugins/skills";
import { BUTTON, Block, FieldRows, Group, ICON_BUTTON, Row, Toggle } from "./controls";
import { openSettings } from "./SettingsDialog";
import { useScopedActions } from "./scope";
import { useSettings } from "./settings";

/*
 * Settings → Plugins (every installed plugin, import, remove) and the
 * section each plugin gets of its own (enable, its settings, its skills).
 */

function useEnabled(id: string): boolean {
  return useSettings((state) => isPluginEnabled(id, state));
}

function EnableToggle({ entry }: { entry: RegisteredPlugin }) {
  const enabled = useEnabled(entry.plugin.id);
  return (
    <Toggle
      label={`${entry.plugin.name} enabled`}
      checked={enabled}
      disabled={entry.plugin.required}
      onChange={(on) => useSettings.getState().updatePluginEntry(entry.plugin.id, { enabled: on })}
    />
  );
}

function errorOf(entry: RegisteredPlugin): string | undefined {
  return loadErrorOf(entry.plugin.id) ?? entry.error;
}

function ImportedBadge() {
  return <span className="ml-1.5 rounded-[4px] bg-raised px-1 text-micro text-fg-dim">Imported</span>;
}

function PluginRow({ entry }: { entry: RegisteredPlugin }) {
  const { plugin, source } = entry;
  const error = errorOf(entry);
  const loading = useInstalledPlugins((state) => state.loading.includes(plugin.id));
  return (
    <Row
      label={
        <>
          <button
            type="button"
            title="Open its settings"
            onClick={() => openSettings(`plugin:${plugin.id}`)}
            className="rounded-sm outline-none hover:text-fg-bright hover:underline hover:decoration-fg-faint hover:underline-offset-2 focus-visible:text-fg-bright"
          >
            {plugin.name}
          </button>
          {plugin.version && <span className="ml-1.5 font-mono text-micro text-fg-faint">{plugin.version}</span>}
          {source.type === "imported" && <ImportedBadge />}
        </>
      }
      help={plugin.description}
      hint={error ? <span className="text-err">{error}</span> : loading ? "Loading…" : undefined}
    >
      {source.type === "imported" && (
        <Menu>
          <MenuTrigger className={ICON_BUTTON} aria-label={`${plugin.name} actions`}>
            <MoreHorizontal size={14} />
          </MenuTrigger>
          <MenuContent className="min-w-[160px]">
            <MenuItem onSelect={() => revealInFileManager(source.dir)}>Reveal in file manager</MenuItem>
            <MenuItem onSelect={() => void removePluginInteractively(plugin.id).catch(reportError)}>Remove</MenuItem>
          </MenuContent>
        </Menu>
      )}
      <EnableToggle entry={entry} />
    </Row>
  );
}

let reportError: (error: unknown) => void = (error) => console.error(error);

export function PluginsSection() {
  usePluginsVersion();
  useInstalledPlugins((state) => state.installed);
  const [problem, setProblem] = useState<string | null>(null);
  reportError = (error) => setProblem(error instanceof Error ? error.message : (error as { message?: string })?.message ?? String(error));
  const registered = allPlugins();
  // Folders that could not even be read as plugins.
  const broken = loadErrorIds().filter((id) => !getPlugin(id));
  const run = (task: Promise<unknown>) => {
    setProblem(null);
    task.catch(reportError);
  };

  return (
    <Group
      title="Installed"
      help="Plugins add pane types. Imported plugins run with the app’s full access; only import plugins you trust."
      actions={
        <>
          <Menu>
            <MenuTrigger className={BUTTON}>
              <Plus size={12} />
              Import
            </MenuTrigger>
            <MenuContent className="min-w-[140px]">
              <MenuItem onSelect={() => run(importPluginInteractively("folder"))}>Folder…</MenuItem>
              <MenuItem onSelect={() => run(importPluginInteractively("zip"))}>.zip…</MenuItem>
            </MenuContent>
          </Menu>
          <Menu>
            <MenuTrigger className={ICON_BUTTON} aria-label="More plugin actions">
              <MoreHorizontal size={14} />
            </MenuTrigger>
            <MenuContent className="min-w-[160px]">
              <MenuItem onSelect={() => run(pluginsDirectory().then((dir) => dir && revealInFileManager(dir)))}>Open plugins folder</MenuItem>
              <MenuItem onSelect={() => run(refreshInstalled())}>Rescan</MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
    >
      {problem && (
        <Block>
          <div className="text-meta text-err">{problem}</div>
        </Block>
      )}
      {registered.map((entry) => (
        <PluginRow key={entry.plugin.id} entry={entry} />
      ))}
      {broken.map((id) => (
        <Row key={id} label={id} hint={<span className="text-err">{loadErrorOf(id)}</span>} />
      ))}
    </Group>
  );
}

function Skills({ pluginId }: { pluginId: string }) {
  useSyncExternalStore(subscribeSkills, skillsVersion);
  useSettings((state) => state.plugins[pluginId]?.skills);
  const skills = allSkills().filter((skill) => skill.pluginId === pluginId);
  const problems = skillProblems(pluginId);
  if (!skills.length && !problems.length) return null;
  return (
    <Group shared title="Skills" help="What an AI agent will be able to do with this plugin. Tools that change things ask before running.">
      {skills.map(({ skill, enabled }) => (
        <Row
          key={skill.id}
          label={skill.title}
          help={skill.description}
          hint={
            <div className="mt-0.5 flex flex-wrap gap-1">
              {skill.tools?.map((tool) => (
                <span
                  key={tool.name}
                  title={tool.effect === "write" ? "Changes things" : "Reads only"}
                  className="inline-flex items-center gap-1 rounded-[4px] bg-raised px-1 font-mono text-micro text-fg-dim"
                >
                  <span className={`size-1.5 rounded-full ${tool.effect === "write" ? "bg-warn" : "bg-fg-faint"}`} />
                  {tool.name}
                </span>
              ))}
              {!skill.tools?.length && <span className="rounded-[4px] bg-raised px-1 text-micro text-fg-faint">Guidance only</span>}
            </div>
          }
        >
          <Toggle label={`Skill ${skill.title}`} checked={enabled} onChange={(on) => setSkillEnabled(pluginId, skill.id, on)} />
        </Row>
      ))}
      {problems.map((problem) => (
        <Block key={problem}>
          <div className="text-meta text-err">{problem}</div>
        </Block>
      ))}
    </Group>
  );
}

export function PluginSection({ pluginId }: { pluginId: string }) {
  usePluginsVersion();
  const entry = getPlugin(pluginId);
  const values = usePluginSettings(pluginId);
  const enabled = useEnabled(pluginId);
  const { updatePluginSettings } = useScopedActions();
  if (!entry) return <div className="text-meta text-fg-dim">This plugin is no longer installed.</div>;
  const { plugin, source } = entry;
  const fields = plugin.settings?.fields ?? [];
  const Custom = plugin.settings?.section;
  const error = errorOf(entry);
  const imported = source.type === "imported";
  const status = error ? (
    <span className="text-err">{error}</span>
  ) : imported ? (
    [plugin.version, source.author].filter(Boolean).join(" · ") || "Imported"
  ) : undefined;
  return (
    <>
      <Group shared>
        <Row label="Enabled" help={plugin.required ? "Always enabled" : undefined} hint={status}>
          {imported && (
            <button type="button" className={BUTTON} onClick={() => void removePluginInteractively(pluginId).catch(reportError)}>
              Remove
            </button>
          )}
          <EnableToggle entry={entry} />
        </Row>
      </Group>
      {enabled && fields.length > 0 && (
        <Group title="Settings">
          <FieldRows fields={fields} values={values} pluginId={pluginId} onChange={(patch) => updatePluginSettings(pluginId, patch)} />
        </Group>
      )}
      {enabled && Custom && <Custom pluginId={pluginId} />}
      {enabled && <Skills pluginId={pluginId} />}
    </>
  );
}
