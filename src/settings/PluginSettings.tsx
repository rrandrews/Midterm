import { useState, useSyncExternalStore } from "react";
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
import { BUTTON, FieldRows, Row, SectionHeading, Toggle } from "./controls";
import { useSettings } from "./settings";

/*
 * Settings → Plugins (every installed plugin, import, remove) and the
 * section each plugin gets of its own (enable, its settings, its skills).
 */

function sourceLabel(entry: RegisteredPlugin): string {
  if (entry.source.type === "builtin") return "Built in";
  return entry.source.author ? `Imported · ${entry.source.author}` : "Imported";
}

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

function PluginRow({ entry }: { entry: RegisteredPlugin }) {
  const { plugin, source } = entry;
  const error = errorOf(entry);
  const loading = useInstalledPlugins((state) => state.loading.includes(plugin.id));
  return (
    <Row
      label={
        <>
          {plugin.name}
          {plugin.version && <span className="ml-1.5 text-meta text-fg-dim">{plugin.version}</span>}
        </>
      }
      hint={
        error ? (
          <span className="text-err">{error}</span>
        ) : loading ? (
          "Loading…"
        ) : (
          [sourceLabel(entry), plugin.description].filter(Boolean).join(" — ")
        )
      }
    >
      {source.type === "imported" && (
        <>
          <button type="button" className={BUTTON} onClick={() => revealInFileManager(source.dir)}>
            Reveal
          </button>
          <button type="button" className={BUTTON} onClick={() => void removePluginInteractively(plugin.id).catch(reportError)}>
            Remove
          </button>
        </>
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
    <>
      <div className="flex items-center gap-1.5 pb-2">
        <button type="button" className={BUTTON} onClick={() => run(importPluginInteractively("folder"))}>
          Import folder…
        </button>
        <button type="button" className={BUTTON} onClick={() => run(importPluginInteractively("zip"))}>
          Import .zip…
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className={BUTTON}
          onClick={() => run(pluginsDirectory().then((dir) => dir && revealInFileManager(dir)))}
        >
          Open plugins folder
        </button>
        <button type="button" className={BUTTON} onClick={() => run(refreshInstalled())}>
          Rescan
        </button>
      </div>
      {problem && <div className="pb-2 text-meta text-err">{problem}</div>}
      {registered.map((entry) => (
        <PluginRow key={entry.plugin.id} entry={entry} />
      ))}
      {broken.map((id) => (
        <Row key={id} label={id} hint={<span className="text-err">{loadErrorOf(id)}</span>} />
      ))}
      <p className="pt-3 text-meta text-fg-dim">
        Plugins add pane types. Imported plugins run with the app’s full access; only import plugins you trust. See
        docs/plugins.md for writing one.
      </p>
    </>
  );
}

function Skills({ pluginId }: { pluginId: string }) {
  useSyncExternalStore(subscribeSkills, skillsVersion);
  useSettings((state) => state.plugins[pluginId]?.skills);
  const skills = allSkills().filter((skill) => skill.pluginId === pluginId);
  const problems = skillProblems(pluginId);
  if (!skills.length && !problems.length) return null;
  return (
    <>
      <SectionHeading>Skills</SectionHeading>
      <p className="pb-1 text-meta text-fg-dim">
        What an AI agent will be able to do with this plugin. Tools marked “changes things” will ask before running.
      </p>
      {skills.map(({ skill, enabled }) => (
        <Row
          key={skill.id}
          label={skill.title}
          hint={
            <>
              <div>{skill.description}</div>
              {skill.tools?.map((tool) => (
                <div key={tool.name} className="font-mono text-micro">
                  {tool.name}
                  <span className={tool.effect === "write" ? "text-warn" : "text-fg-faint"}>
                    {" "}
                    · {tool.effect === "write" ? "changes things" : "reads"}
                  </span>
                </div>
              ))}
              {!skill.tools?.length && <div className="text-micro text-fg-faint">Guidance only</div>}
            </>
          }
        >
          <Toggle label={`Skill ${skill.title}`} checked={enabled} onChange={(on) => setSkillEnabled(pluginId, skill.id, on)} />
        </Row>
      ))}
      {problems.map((problem) => (
        <div key={problem} className="py-1 text-meta text-err">
          {problem}
        </div>
      ))}
    </>
  );
}

export function PluginSection({ pluginId }: { pluginId: string }) {
  usePluginsVersion();
  const entry = getPlugin(pluginId);
  const values = usePluginSettings(pluginId);
  const enabled = useEnabled(pluginId);
  if (!entry) return <div className="text-meta text-fg-dim">This plugin is no longer installed.</div>;
  const { plugin, source } = entry;
  const fields = plugin.settings?.fields ?? [];
  const Custom = plugin.settings?.section;
  const error = errorOf(entry);
  return (
    <>
      <div className="flex items-start gap-3 border-b border-line/60 pb-3">
        <div className="min-w-0 flex-1">
          <div className="text-menu font-medium text-fg-bright">
            {plugin.name}
            {plugin.version && <span className="ml-1.5 text-meta font-normal text-fg-dim">{plugin.version}</span>}
          </div>
          <div className="text-meta text-fg-dim">{[sourceLabel(entry), plugin.description].filter(Boolean).join(" — ")}</div>
          {error && <div className="text-meta text-err">{error}</div>}
          {plugin.required && <div className="text-meta text-fg-faint">Always enabled.</div>}
        </div>
        {source.type === "imported" && (
          <button type="button" className={BUTTON} onClick={() => void removePluginInteractively(pluginId).catch(reportError)}>
            Remove
          </button>
        )}
        <EnableToggle entry={entry} />
      </div>
      {enabled && fields.length > 0 && (
        <FieldRows
          fields={fields}
          values={values}
          onChange={(patch) => useSettings.getState().updatePluginSettings(pluginId, patch)}
        />
      )}
      {enabled && Custom && <Custom pluginId={pluginId} />}
      {enabled && !fields.length && !Custom && (
        <div className="py-2 text-meta text-fg-dim">This plugin has no settings.</div>
      )}
      {!enabled && <div className="py-2 text-meta text-fg-dim">Enable the plugin to change its settings.</div>}
      {enabled && <Skills pluginId={pluginId} />}
    </>
  );
}
