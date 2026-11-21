import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Plus, Puzzle, RefreshCcwDot, RefreshCw, RotateCw, Search, Server, ShieldAlert, Store, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { confirm } from "../../../components/ui/ConfirmDialog";
import { DotsIcon } from "../../../components/ui/icons";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../../../components/ui/Menu";
import { Toggle } from "../../../settings/controls";
import { request } from "../../client";
import type { AvailablePlugin, InstalledPlugin, Marketplace, McpServerStatus, PluginCommandResult, PluginScope } from "../../protocol";
import { getSession, hasProcess, updateSession, useClaudeStore, useSession } from "../../store";
import { formatTokens } from "./format";
import { Badge, Button, Dot, Empty, ErrorLine, IconButton, Segmented, Spinner, type Tone, Toolbar, errorText, useRowCommands } from "./shared";

/*
 * Plugins: installed plugins (enable, update, uninstall), discovery over the
 * marketplaces' plugins (virtualized; install with a scope), marketplaces
 * (add, update, remove) and the session's MCP servers (enable, reconnect).
 * Plugin changes reach a running session only after a reload, offered in a
 * bar at the bottom.
 */

type View = "installed" | "discover" | "marketplaces" | "mcp";

/** What outlives the panel being closed: lists per folder, the view and the reload flag per session. */
type PanelState = {
  installed: Record<string, InstalledPlugin[]>;
  available: Record<string, AvailablePlugin[]>;
  marketplaces: Record<string, Marketplace[]>;
  view: Record<string, View>;
  /** Plugin changes that reached each session (a counter), and the last one a reload covered. */
  changes: Record<string, number>;
  reloaded: Record<string, number>;
  reloading: Record<string, boolean>;
};
const usePanelState = create<PanelState>(() => ({ installed: {}, available: {}, marketplaces: {}, view: {}, changes: {}, reloaded: {}, reloading: {} }));
const needsReload = (state: PanelState, sessionKey: string) => (state.changes[sessionKey] ?? 0) > (state.reloaded[sessionKey] ?? 0);
/** Marks the changes up to `revision` (default: all so far) as covered for a session. */
const coverChanges = (sessionKey: string, revision?: number) =>
  usePanelState.setState((state) => {
    const upTo = revision ?? state.changes[sessionKey] ?? 0;
    return { reloaded: { ...state.reloaded, [sessionKey]: Math.max(state.reloaded[sessionKey] ?? 0, upTo) } };
  });
const patch = <K extends keyof PanelState>(key: K, id: string, value: PanelState[K][string]) =>
  usePanelState.setState((state) => ({ [key]: { ...state[key], [id]: value } }) as Partial<PanelState>);

const SCOPES: { scope: PluginScope; label: string; hint: string }[] = [
  { scope: "user", label: "User", hint: "all your projects" },
  { scope: "project", label: "Project", hint: "shared with the repo" },
  { scope: "local", label: "Local", hint: "this project, only you" },
];

function splitId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id };
}

const trimSlash = (path: string) => path.replace(/(.)\/+$/, "$1");

/**
 * Where an installed plugin applies, seen from `cwd`. `claude plugin list`
 * lists local and project installs of every project; `enabled` is the
 * plugin's state in `cwd`'s merged settings, so it only describes the rows
 * of this folder. Rows of another project are shown but not toggled, and
 * scopes the CLI cannot change (e.g. `synced`) are read-only.
 */
function placeOf(plugin: InstalledPlugin, cwd: string): { kind: "here" } | { kind: "other"; path: string } | { kind: "readonly" } {
  const scope: string = plugin.scope;
  if (scope !== "user" && scope !== "project" && scope !== "local") return { kind: "readonly" };
  if (scope !== "user" && plugin.projectPath && trimSlash(plugin.projectPath) !== trimSlash(cwd)) return { kind: "other", path: plugin.projectPath };
  return { kind: "here" };
}

/** "1.0.1-73c8cf3ea7e2" → "1.0.1-73c8cf3": long hex runs (commit hashes) cut to 7. */
function shortVersion(version: string): string {
  return version.replace(/^v/, "").replace(/[0-9a-f]{8,}/g, (hash) => (/[a-f]/.test(hash) ? hash.slice(0, 7) : hash));
}

/** One installation (the same plugin can be installed in several scopes and projects). */
const installationKey = (plugin: InstalledPlugin) => [plugin.id, plugin.scope, plugin.projectPath ?? "", plugin.installPath ?? ""].join("\u0000");

async function loadInstalled(cwd: string): Promise<void> {
  const result = await request("plugins.list", { cwd });
  patch("installed", cwd, result.installed);
}

async function loadAvailable(cwd: string): Promise<void> {
  const result = await request("plugins.list", { cwd, available: true });
  patch("installed", cwd, result.installed);
  patch("available", cwd, result.available);
}

async function loadMarketplaces(cwd: string): Promise<void> {
  patch("marketplaces", cwd, await request("marketplaces.list", { cwd }));
}

export function PluginsPanel({ sessionKey }: { sessionKey: string }) {
  const cwd = useSession(sessionKey, (session) => session?.cwd ?? "");
  const view = usePanelState((state) => state.view[sessionKey] ?? "installed");
  const installedCount = usePanelState((state) => state.installed[cwd]?.length);
  const mcpCount = useSession(sessionKey, (session) => session?.mcpServers.length ?? 0);

  return (
    <>
      <Toolbar>
        <Segmented<View>
          label="Plugins view"
          className="cp-grow"
          value={view}
          onChange={(next) => patch("view", sessionKey, next)}
          options={[
            { value: "installed", label: <>Installed{installedCount ? <span className="cp-segment-count">{installedCount}</span> : null}</> },
            { value: "discover", label: "Discover" },
            { value: "marketplaces", label: "Markets", title: "Marketplaces" },
            { value: "mcp", label: <>MCP{mcpCount ? <span className="cp-segment-count">{mcpCount}</span> : null}</> },
          ]}
        />
        <ReloadButton sessionKey={sessionKey} />
      </Toolbar>
      {view === "installed" && <InstalledView sessionKey={sessionKey} cwd={cwd} />}
      {view === "discover" && <DiscoverView cwd={cwd} />}
      {view === "marketplaces" && <MarketplacesView cwd={cwd} />}
      {view === "mcp" && <McpView sessionKey={sessionKey} />}
      <ReloadBar sessionKey={sessionKey} />
    </>
  );
}

/** Loads something on mount (and when `deps` change) with loading and error state; `retry` loads again, forced. */
function useLoad(load: (force: boolean) => Promise<void>, deps: unknown[]) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (force = false) => {
    setLoading(true);
    setError(undefined);
    try {
      await load(force);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void run(), deps);
  return { loading, error, retry: () => run(true) };
}

/**
 * After a plugin change, flags every running session it reaches for a
 * reload: a user-scope change (or a marketplace change, `"all"`) reaches
 * every session; a project or local one the sessions in that folder.
 * Sessions without a process load plugins fresh when they start.
 */
function markChanged(scope: PluginScope | "all", cwd: string): void {
  const affected = Object.values(useClaudeStore.getState().sessions)
    .filter((session) => session.status === "idle" || session.status === "running")
    .filter((session) => scope === "all" || scope === "user" || trimSlash(session.cwd) === trimSlash(cwd))
    .map((session) => session.key);
  if (affected.length === 0) return;
  usePanelState.setState((state) => ({ changes: { ...state.changes, ...Object.fromEntries(affected.map((key) => [key, (state.changes[key] ?? 0) + 1])) } }));
}

/** Whether a session has plugin changes it has not reloaded (for a hint outside this panel). */
export function usePluginReloadNeeded(sessionKey: string): boolean {
  return usePanelState((state) => needsReload(state, sessionKey));
}

/** Reloads plugins from disk into a running session, then its commands, models and agents. */
async function reloadPlugins(sessionKey: string): Promise<void> {
  // A change that arrives while this reload runs is not covered by it: the bar stays for it.
  const revision = usePanelState.getState().changes[sessionKey] ?? 0;
  patch("reloading", sessionKey, true);
  try {
    const reloaded = await request("session.reloadPlugins", { session: sessionKey });
    const capabilities = await request("session.capabilities", { session: sessionKey });
    const init = getSession(sessionKey)?.init;
    updateSession(sessionKey, {
      ...(init ? { init: { ...init, commands: capabilities.commands, models: capabilities.models, agents: capabilities.agents } } : {}),
      ...(reloaded.mcpServers ? { mcpServers: reloaded.mcpServers } : {}),
    });
    coverChanges(sessionKey, revision);
  } finally {
    patch("reloading", sessionKey, false);
  }
}

/* ---- Marketplace commands that need approval ---- */

type CommandConfirm = NonNullable<PluginCommandResult["confirm"]>;
type Approval = { confirm: CommandConfirm; verb: "install" | "update"; approve: () => void };

/**
 * Installs and updates that came back asking to run a marketplace command:
 * nothing happened yet. Each row shows the command until it is approved
 * (the request is sent again with its digest) or cancelled.
 */
function useApprovals() {
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const ask = (key: string, approval: Approval) => setApprovals((current) => ({ ...current, [key]: approval }));
  const drop = (key: string) => setApprovals(({ [key]: _, ...rest }) => rest);
  return { approvals, ask, drop };
}

function CommandApproval({ approval, onCancel }: { approval: Approval; onCancel: () => void }) {
  const run = useRef<HTMLButtonElement>(null);
  useEffect(() => run.current?.focus({ preventScroll: true }), []);
  return (
    <div className="cp-approval" role="alertdialog" aria-label="Approve a marketplace command">
      <div className="cp-approval-head">
        <ShieldAlert size={12} aria-hidden="true" />
        This plugin’s marketplace wants to run a command during {approval.verb}
      </div>
      <pre className="cp-approval-command">{approval.confirm.command}</pre>
      {approval.confirm.message && <p className="cp-approval-message">{approval.confirm.message}</p>}
      <div className="cp-approval-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button ref={run} variant="primary" onClick={approval.approve}>
          Run and {approval.verb}
        </Button>
      </div>
    </div>
  );
}

/* ---- Installed ---- */

function InstalledView({ sessionKey, cwd }: { sessionKey: string; cwd: string }) {
  const installed = usePanelState((state) => state.installed[cwd]);
  const { loading, error, retry } = useLoad(() => loadInstalled(cwd), [cwd]);
  const commands = useRowCommands();
  const { approvals, ask, drop } = useApprovals();
  // This folder's plugins first, then other projects' installs, each by name.
  const sorted = useMemo(
    () =>
      [...(installed ?? [])].sort(
        (a, b) => Number(placeOf(a, cwd).kind !== "here") - Number(placeOf(b, cwd).kind !== "here") || a.id.localeCompare(b.id),
      ),
    [installed, cwd],
  );

  const act = async (plugin: InstalledPlugin, method: "plugins.enable" | "plugins.disable" | "plugins.uninstall", what: string) => {
    const key = installationKey(plugin);
    const ok = await commands.run(key, what, async () => {
      await request(method, { cwd, id: plugin.id, scope: plugin.scope });
      await loadInstalled(cwd);
    });
    if (ok) markChanged(plugin.scope, cwd);
  };

  const update = async (plugin: InstalledPlugin, acceptCommand?: string) => {
    const key = installationKey(plugin);
    drop(key);
    let asked: CommandConfirm | undefined;
    const ok = await commands.run(key, "Updating", async () => {
      const result = await request("plugins.update", { cwd, id: plugin.id, scope: plugin.scope, acceptCommand });
      asked = result.confirm;
      if (!asked) await loadInstalled(cwd);
    });
    const confirmation = asked;
    if (confirmation) ask(key, { confirm: confirmation, verb: "update", approve: () => void update(plugin, confirmation.digest) });
    else if (ok) markChanged(plugin.scope, cwd);
  };

  const uninstall = async (plugin: InstalledPlugin) => {
    const { name } = splitId(plugin.id);
    const ok = await confirm({
      title: `Uninstall ${name}?`,
      message: `This removes the plugin from the ${plugin.scope} scope. Its commands, agents, skills and MCP servers go with it.`,
      action: "Uninstall",
    });
    if (ok) await act(plugin, "plugins.uninstall", "Uninstalling");
  };

  return (
    <div className="cp-body">
      {error && <ErrorLine onRetry={retry}>{error}</ErrorLine>}
      {!installed && loading ? (
        <Loading>Loading plugins…</Loading>
      ) : installed && sorted.length === 0 && !error ? (
        <Empty icon={<Puzzle size={18} />} title="No plugins installed">
          Plugins add commands, agents, skills, hooks and MCP servers.{" "}
          <button type="button" className="cp-link" onClick={() => patch("view", sessionKey, "discover")}>
            Discover plugins
          </button>
        </Empty>
      ) : (
        <ul className="cp-list">
          {sorted.map((plugin) => {
            const key = installationKey(plugin);
            const { name, marketplace } = splitId(plugin.id);
            const busy = commands.busy[key];
            const place = placeOf(plugin, cwd);
            const here = place.kind === "here";
            // Read-only rows show what the CLI reports; only this folder's rows can change.
            const on = plugin.enabled;
            const lockedWhy =
              place.kind === "other"
                ? `Installed for another project (${place.path}). Open a session there to change it.`
                : place.kind === "readonly"
                  ? `The ${plugin.scope} scope is not managed by Claude Code’s plugin commands.`
                  : undefined;
            return (
              <li key={key} className={`cp-row cp-row-plugin${on ? "" : " cp-row-off"}`}>
                <div className="cp-row-main">
                  <div className="cp-row-title">
                    <span className="cp-row-name" title={plugin.id}>
                      {name}
                    </span>
                  </div>
                  <div className="cp-row-meta">
                    <Badge tone={plugin.scope === "project" || plugin.scope === "local" ? "info" : undefined}>{plugin.scope}</Badge>
                    {place.kind === "other" && <Badge title={`Installed for another project: ${place.path}`}>other project</Badge>}
                    {plugin.version && (
                      <span className="cp-mono cp-version" title={plugin.version}>
                        v{shortVersion(plugin.version)}
                      </span>
                    )}
                    {busy ? (
                      <span className="cp-accent">{busy}…</span>
                    ) : place.kind === "other" ? (
                      <span className="cp-truncate cp-fg-mid" title={place.path}>
                        {place.path.split("/").filter(Boolean).pop() ?? place.path}
                      </span>
                    ) : (
                      marketplace && (
                        <span className="cp-truncate cp-faint" title={marketplace}>
                          {marketplace}
                        </span>
                      )
                    )}
                  </div>
                  {commands.errors[key] && <span className="cp-row-error">{commands.errors[key]}</span>}
                </div>
                <div className="cp-row-actions">
                  {busy ? (
                    <Spinner />
                  ) : (
                    <span title={lockedWhy} className="flex">
                      <Toggle
                        label={on ? `Disable ${name}` : `Enable ${name}`}
                        checked={on}
                        disabled={!here}
                        onChange={(enabled) => void act(plugin, enabled ? "plugins.enable" : "plugins.disable", enabled ? "Enabling" : "Disabling")}
                      />
                    </span>
                  )}
                  <Menu modal={false}>
                    <MenuTrigger asChild>
                      <button type="button" className="cp-icon-button" aria-label={`More for ${name}`} title={lockedWhy ?? "More"} disabled={!!busy || !here}>
                        <DotsIcon size={12} />
                      </button>
                    </MenuTrigger>
                    <MenuContent onCloseAutoFocus={() => {}}>
                      <MenuItem onSelect={() => void update(plugin)}>Update</MenuItem>
                      <MenuSeparator />
                      <MenuItem onSelect={() => void uninstall(plugin)}>
                        <span className="text-err">Uninstall…</span>
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
                {approvals[key] && <CommandApproval approval={approvals[key]} onCancel={() => drop(key)} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---- Discover ---- */

function DiscoverView({ cwd }: { cwd: string }) {
  const available = usePanelState((state) => state.available[cwd]);
  const installed = usePanelState((state) => state.installed[cwd]);
  const { loading, error, retry } = useLoad(async (force) => {
    if (force || !usePanelState.getState().available[cwd]) await loadAvailable(cwd);
  }, [cwd]);
  const [query, setQuery] = useState("");
  const commands = useRowCommands();
  const scroller = useRef<HTMLDivElement>(null);

  // Installed here: another project's local install does not count.
  const installedIds = useMemo(() => new Set((installed ?? []).filter((plugin) => placeOf(plugin, cwd).kind !== "other").map((plugin) => plugin.id)), [installed, cwd]);
  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = (available ?? []).filter((plugin) => {
      if (terms.length === 0) return true;
      const haystack = `${plugin.name} ${plugin.marketplaceName} ${plugin.description ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return list.sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0) || a.name.localeCompare(b.name));
  }, [available, query]);

  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 62,
    overscan: 8,
    getItemKey: (index) => results[index].pluginId,
  });

  const { approvals, ask, drop } = useApprovals();

  const install = async (plugin: AvailablePlugin, scope: PluginScope, acceptCommand?: string) => {
    const key = plugin.pluginId;
    drop(key);
    let asked: CommandConfirm | undefined;
    const ok = await commands.run(key, "Installing", async () => {
      const result = await request("plugins.install", { cwd, id: plugin.pluginId, scope, acceptCommand });
      asked = result.confirm;
      if (!asked) await loadInstalled(cwd);
    });
    const confirmation = asked;
    if (confirmation) ask(key, { confirm: confirmation, verb: "install", approve: () => void install(plugin, scope, confirmation.digest) });
    else if (ok) markChanged(scope, cwd);
  };

  return (
    <>
      <div className="cp-search">
        <Search size={12} className="cp-search-icon" aria-hidden="true" />
        <input
          className="cp-search-input"
          type="search"
          spellCheck={false}
          placeholder={available ? `Search ${available.length.toLocaleString()} plugins` : "Search plugins"}
          aria-label="Search plugins"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            scroller.current?.scrollTo({ top: 0 });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
        {query && (
          <button type="button" className="cp-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={11} />
          </button>
        )}
        <IconButton label="Refresh the list" busy={loading} onClick={() => void retry()}>
          <RotateCw size={12} />
        </IconButton>
      </div>
      <div ref={scroller} className="cp-body cp-body-flush cp-virtual">
        {error && <ErrorLine onRetry={retry}>{error}</ErrorLine>}
        {!available ? (
          loading && <Loading>Loading marketplaces…</Loading>
        ) : results.length === 0 ? (
          <Empty icon={<Search size={18} />} title="No matching plugins">
            {query ? "Try other words, or add a marketplace." : "Add a marketplace to discover plugins."}
          </Empty>
        ) : (
          <ul className="cp-vlist" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const plugin = results[item.index];
              const busy = commands.busy[plugin.pluginId];
              const isInstalled = installedIds.has(plugin.pluginId);
              return (
                <li key={item.key} data-index={item.index} ref={virtualizer.measureElement} className="cp-discover" style={{ transform: `translateY(${item.start}px)` }}>
                  <div className="cp-discover-head">
                    <span className="cp-row-name">{plugin.name}</span>
                    <span className="cp-row-sub">@{plugin.marketplaceName}</span>
                    <span className="cp-grow" />
                    {plugin.installCount !== undefined && (
                      <span className="cp-installs" title={`${plugin.installCount.toLocaleString()} installs`}>
                        <Download size={10} aria-hidden="true" />
                        {formatTokens(plugin.installCount)}
                      </span>
                    )}
                  </div>
                  <div className="cp-discover-body">
                    <p className="cp-discover-desc">{plugin.description || <span className="cp-faint">No description.</span>}</p>
                    {approvals[plugin.pluginId] ? null : isInstalled ? (
                      <Badge tone="ok">Installed</Badge>
                    ) : busy ? (
                      <Button disabled busy>
                        Installing
                      </Button>
                    ) : (
                      <Menu modal={false}>
                        <MenuTrigger asChild>
                          <button type="button" className="cp-button cp-button-default" aria-label={`Install ${plugin.name}`}>
                            Install
                          </button>
                        </MenuTrigger>
                        <MenuContent onCloseAutoFocus={() => {}}>
                          {SCOPES.map(({ scope, label, hint }) => (
                            <MenuItem key={scope} onSelect={() => void install(plugin, scope)}>
                              {label} <span className="text-fg-dim">· {hint}</span>
                            </MenuItem>
                          ))}
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                  {commands.errors[plugin.pluginId] && <span className="cp-row-error">{commands.errors[plugin.pluginId]}</span>}
                  {approvals[plugin.pluginId] && <CommandApproval approval={approvals[plugin.pluginId]} onCancel={() => drop(plugin.pluginId)} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/* ---- Marketplaces ---- */

function MarketplacesView({ cwd }: { cwd: string }) {
  const marketplaces = usePanelState((state) => state.marketplaces[cwd]);
  const { loading, error, retry } = useLoad(() => loadMarketplaces(cwd), [cwd]);
  const commands = useRowCommands();
  const [source, setSource] = useState("");

  const after = async () => {
    await loadMarketplaces(cwd);
    // The available list changes with the marketplaces.
    usePanelState.setState((state) => {
      const { [cwd]: _, ...available } = state.available;
      return { available };
    });
    markChanged("all", cwd);
  };

  const add = async () => {
    const text = source.trim();
    if (!text) return;
    const ok = await commands.run("+add", "Adding", async () => {
      await request("marketplaces.add", { cwd, source: text });
      await after();
    });
    if (ok) setSource("");
  };

  const remove = async (market: Marketplace) => {
    const ok = await confirm({
      title: `Remove ${market.name}?`,
      message: "Plugins installed from this marketplace are uninstalled with it.",
      action: "Remove",
    });
    if (ok) await commands.run(market.name, "Removing", async () => {
      await request("marketplaces.remove", { cwd, name: market.name });
      await after();
      await loadInstalled(cwd);
    });
  };

  return (
    <div className="cp-body">
      <form
        className="cp-add"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          className="cp-input cp-mono cp-grow"
          spellCheck={false}
          placeholder="owner/repo, URL or path"
          aria-label="Marketplace source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
        <Button type="submit" variant="primary" busy={!!commands.busy["+add"]} disabled={!source.trim()}>
          {!commands.busy["+add"] && <Plus size={12} />}
          Add
        </Button>
      </form>
      {commands.errors["+add"] && <ErrorLine>{commands.errors["+add"]}</ErrorLine>}
      {error && <ErrorLine onRetry={retry}>{error}</ErrorLine>}

      <div className="cp-heading">
        <span>Marketplaces</span>
        <span className="cp-heading-aside">
          <Button
            variant="ghost"
            busy={!!commands.busy["*"]}
            disabled={!marketplaces?.length}
            onClick={() => void commands.run("*", "Updating", async () => {
              await request("marketplaces.update", { cwd });
              await after();
            })}
          >
            {!commands.busy["*"] && <RefreshCw size={11} />}
            Update all
          </Button>
        </span>
      </div>
      {commands.errors["*"] && <ErrorLine>{commands.errors["*"]}</ErrorLine>}

      {!marketplaces && loading ? (
        <Loading>Loading marketplaces…</Loading>
      ) : marketplaces?.length === 0 ? (
        <Empty icon={<Store size={18} />} title="No marketplaces">
          Add one by its GitHub repo, a git URL or a local path.
        </Empty>
      ) : (
        <ul className="cp-list">
          {marketplaces?.map((market) => {
            const busy = commands.busy[market.name];
            const where = market.repo ?? market.url ?? market.path ?? market.source;
            return (
              <li key={market.name} className="cp-row">
                <div className="cp-row-main">
                  <div className="cp-row-title">
                    <Store size={11} className="cp-row-icon" aria-hidden="true" />
                    <span className="cp-row-name">{market.name}</span>
                  </div>
                  {where && (
                    <div className="cp-row-meta">
                      <span className="cp-mono cp-truncate" title={where}>
                        {where}
                      </span>
                    </div>
                  )}
                  {busy && <span className="cp-row-meta cp-accent">{busy}…</span>}
                  {commands.errors[market.name] && <span className="cp-row-error">{commands.errors[market.name]}</span>}
                </div>
                <div className="cp-row-actions">
                  <IconButton
                    label={`Update ${market.name}`}
                    busy={busy === "Updating"}
                    disabled={!!busy}
                    onClick={() => void commands.run(market.name, "Updating", async () => {
                      await request("marketplaces.update", { cwd, name: market.name });
                      await after();
                    })}
                  >
                    <RefreshCw size={12} />
                  </IconButton>
                  <IconButton label={`Remove ${market.name}`} busy={busy === "Removing"} disabled={!!busy} className="cp-danger" onClick={() => void remove(market)}>
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---- MCP servers ---- */

const MCP_STATUS: Record<string, { tone: Tone; label: string; pulse?: boolean; hollow?: boolean }> = {
  connected: { tone: "ok", label: "Connected" },
  failed: { tone: "err", label: "Failed" },
  "needs-auth": { tone: "warn", label: "Needs authentication" },
  pending: { tone: "accent", label: "Connecting", pulse: true },
  disabled: { tone: "dim", label: "Disabled", hollow: true },
};

function McpView({ sessionKey }: { sessionKey: string }) {
  const servers = useSession(sessionKey, (session) => session?.mcpServers) as McpServerStatus[] | undefined;
  const status = useSession(sessionKey, (session) => session?.status);
  const live = status === "idle" || status === "running";
  const commands = useRowCommands();

  const refresh = async () => {
    if (!hasProcess(sessionKey)) return;
    updateSession(sessionKey, { mcpServers: await request("session.mcpStatus", { session: sessionKey }) });
  };
  const { loading, error, retry } = useLoad(refresh, [live]);

  const toggle = (server: McpServerStatus, enabled: boolean) =>
    void commands.run(server.name, enabled ? "Enabling" : "Disabling", async () => {
      await request("session.mcpToggle", { session: sessionKey, server: server.name, enabled });
      await refresh();
    });
  const reconnect = (server: McpServerStatus) =>
    void commands.run(server.name, "Reconnecting", async () => {
      await request("session.mcpReconnect", { session: sessionKey, server: server.name });
      await refresh();
    });

  const list = [...(servers ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="cp-body">
      <div className="cp-heading">
        <span>This session’s servers</span>
        <span className="cp-heading-aside">
          <IconButton label="Refresh" busy={loading} disabled={!live} onClick={() => void retry()}>
            <RotateCw size={12} />
          </IconButton>
        </span>
      </div>
      {error && <ErrorLine onRetry={retry}>{error}</ErrorLine>}
      {list.length === 0 ? (
        <Empty icon={<Server size={18} />} title={live ? "No MCP servers" : "Session not started"}>
          {live ? "Add servers in your settings or with a plugin." : "Send a message to start the session; its MCP servers appear here."}
        </Empty>
      ) : (
        <ul className="cp-list">
          {list.map((server) => {
            const state = MCP_STATUS[server.status] ?? MCP_STATUS.pending;
            const busy = commands.busy[server.name];
            const origin = server.source ?? server.scope;
            const tools = server.tools?.length;
            return (
              <li key={server.name} className={`cp-row${server.status === "disabled" ? " cp-row-off" : ""}`}>
                <div className="cp-row-main">
                  <div className="cp-row-title">
                    <Dot tone={state.tone} pulse={state.pulse} hollow={state.hollow} label={state.label} />
                    <span className="cp-row-name">{server.name}</span>
                  </div>
                  <div className="cp-row-meta">
                    {origin && <Badge>{origin}</Badge>}
                    {busy ? (
                      <span className="cp-accent">{busy}…</span>
                    ) : (
                      <span className={server.status === "failed" ? "cp-err" : server.status === "needs-auth" ? "cp-warn" : undefined}>{state.label}</span>
                    )}
                    {tools !== undefined && server.status === "connected" && <span>{tools} {tools === 1 ? "tool" : "tools"}</span>}
                    {server.serverInfo?.version && <span className="cp-mono">v{server.serverInfo.version}</span>}
                  </div>
                  {server.error && server.status === "failed" && <span className="cp-row-error">{server.error}</span>}
                  {commands.errors[server.name] && <span className="cp-row-error">{commands.errors[server.name]}</span>}
                </div>
                <div className="cp-row-actions">
                  <IconButton label={`Reconnect ${server.name}`} disabled={!live || !!busy || server.status === "disabled"} onClick={() => reconnect(server)}>
                    <RotateCw size={12} />
                  </IconButton>
                  <Toggle label={`Enable ${server.name}`} checked={server.status !== "disabled"} disabled={!live || !!busy} onChange={(enabled) => toggle(server, enabled)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---- Reload ---- */

/** Reloads plugins into this session on demand (changes made outside Midterm are not seen). */
function ReloadButton({ sessionKey }: { sessionKey: string }) {
  const live = useSession(sessionKey, (session) => session?.status === "idle" || session?.status === "running");
  const busy = usePanelState((state) => state.reloading[sessionKey] ?? false);
  const [error, setError] = useState<string>();
  return (
    <IconButton
      label={error ? `Reload failed: ${error}` : live ? "Reload plugins into this session" : "Reload plugins (the session is not running)"}
      className={error ? "cp-err" : ""}
      busy={busy}
      disabled={!live}
      onClick={() => {
        setError(undefined);
        reloadPlugins(sessionKey).catch((failure) => setError(errorText(failure)));
      }}
    >
      <RefreshCcwDot size={12} />
    </IconButton>
  );
}

function ReloadBar({ sessionKey }: { sessionKey: string }) {
  const needed = usePanelState((state) => needsReload(state, sessionKey));
  const busy = usePanelState((state) => state.reloading[sessionKey] ?? false);
  const live = useSession(sessionKey, (session) => session?.status === "idle" || session?.status === "running");
  const [error, setError] = useState<string>();
  if (!needed || !live) return null;

  return (
    <div className="cp-reload" role="status">
      <div className="cp-reload-text">
        {error ? <span className="cp-err">{error}</span> : "Plugins changed. This session still has the old set."}
      </div>
      <IconButton label="Dismiss" onClick={() => coverChanges(sessionKey)}>
        <X size={12} />
      </IconButton>
      <Button
        variant="primary"
        busy={busy}
        onClick={() => {
          setError(undefined);
          reloadPlugins(sessionKey).catch((failure) => setError(errorText(failure)));
        }}
      >
        Reload plugins into this session
      </Button>
    </div>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="cp-loading">
      <Spinner /> {children}
    </div>
  );
}
