import { ChartPie, FoldVertical, RotateCw } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { openFile } from "../../../actions";
import { homeDirectory } from "../../../ipc/system";
import { request } from "../../client";
import type { ContextUsage } from "../../protocol";
import { getSession, hasProcess, refreshContext, sendMessage, updateSession, useSession } from "../../store";
import type { SessionStatus } from "../../types";
import { type ContextCategory, categoriesByName, categoryStyle } from "./categories";
import { formatPercent, formatTokens, shortModel, tildePath } from "./format";
import { Badge, Button, Empty, ErrorLine, IconButton, Section, Spinner, Toolbar, errorText } from "./shared";

/*
 * Context: what fills the context window. The SDK's grid of squares in
 * category colors, a legend, the autocompact threshold, and what is loaded
 * (memory files, MCP tools, agents, skills, the message breakdown).
 */

export function ContextPanel({ sessionKey }: { sessionKey: string }) {
  const context = useSession(sessionKey, (session) => session?.context);
  const status = useSession(sessionKey, (session) => session?.status);
  const live = status === "idle" || status === "running";
  const [loading, setLoading] = useState<false | "summary" | "full">(false);
  const [error, setError] = useState<string>();

  const load = async (detail: "summary" | "full") => {
    if (!hasProcess(sessionKey)) return;
    setLoading(detail);
    setError(undefined);
    try {
      if (detail === "full") {
        const usage = await request("session.contextUsage", { session: sessionKey, detail: "full" });
        updateSession(sessionKey, { context: usage });
      } else {
        await refreshContext(sessionKey);
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLoading(false);
    }
  };

  // On open, once the process is up, and after each turn.
  const previous = useRef<SessionStatus | undefined>(undefined);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (!live || was === status) return;
    if (was === undefined || status === "idle") void load("summary");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const compact = () => {
    void sendMessage(sessionKey, "/compact").catch((failure) => setError(errorText(failure)));
  };

  return (
    <>
      <Toolbar>
        {context ? (
          <span className="cp-toolbar-text cp-mono" title={context.model}>
            {shortModel(context.model)} · {formatTokens(context.maxTokens)}
          </span>
        ) : (
          <span className="cp-toolbar-text">Context window</span>
        )}
        <span className="cp-grow" />
        <IconButton label="Refresh (full count)" busy={loading !== false} disabled={!live} onClick={() => void load("full")}>
          <RotateCw size={12} />
        </IconButton>
        <Button disabled={!live || status === "running"} title="Summarize the conversation to free context (/compact)" onClick={compact}>
          <FoldVertical size={12} />
          Compact
        </Button>
      </Toolbar>
      <div className="cp-body">
        {error && <ErrorLine onRetry={() => void load("full")}>{error}</ErrorLine>}
        {!context ? (
          !live && status !== "starting" ? (
            <Empty icon={<ChartPie size={18} />} title="No context yet">
              Send a message to start the session; context appears here.
            </Empty>
          ) : (
            <div className="cp-loading">
              <Spinner /> Measuring context…
            </div>
          )
        ) : (
          <ContextView sessionKey={sessionKey} context={context} />
        )}
      </div>
    </>
  );
}

function ContextView({ sessionKey, context }: { sessionKey: string; context: ContextUsage }) {
  const [hovered, setHovered] = useState<string>();
  const byName = useMemo(() => categoriesByName(context), [context]);
  const used = context.categories.filter((category) => category.kind === "used" && category.tokens > 0);
  const reserved = context.categories.filter((category) => category.kind === "buffer" || category.kind === "free");
  const deferred = context.categories.filter((category) => category.kind === "deferred" && category.tokens > 0);
  const percent = context.maxTokens > 0 ? (context.totalTokens / context.maxTokens) * 100 : context.percentage;
  const threshold = context.autoCompactThreshold;
  const free = context.categories.find((category) => category.kind === "free")?.tokens;
  const columns = Math.max(0, ...context.gridRows.map((row) => row.length));

  return (
    <>
      <div className="cp-ctx-overview" data-wide={columns > 12 ? "" : undefined}>
        {context.gridRows.length > 0 && <Grid context={context} byName={byName} hovered={hovered} />}
        <div className="cp-ctx-stats">
          <div className="cp-ctx-percent">
            {Math.round(percent)}
            <span>%</span>
          </div>
          <div className="cp-ctx-line">
            <span className="cp-mono cp-fg">{formatTokens(context.totalTokens)}</span> of <span className="cp-mono">{formatTokens(context.maxTokens)}</span> tokens
          </div>
          {free !== undefined && (
            <div className="cp-ctx-line">
              <span className="cp-mono">{formatTokens(free)}</span> free
            </div>
          )}
          <div className="cp-ctx-line">
            {context.isAutoCompactEnabled && threshold ? (
              <>
                Autocompact at <span className="cp-mono">{formatTokens(threshold)}</span>
                <span className="cp-faint"> ({formatPercent(threshold, context.maxTokens)})</span>
              </>
            ) : (
              "Autocompact off"
            )}
          </div>
        </div>
      </div>

      <ul className="cp-legend" onMouseLeave={() => setHovered(undefined)}>
        {used.map((category) => (
          <LegendRow key={category.name} category={category} max={context.maxTokens} onHover={setHovered} />
        ))}
        {reserved.length > 0 && <li className="cp-legend-gap" aria-hidden="true" />}
        {reserved.map((category) => (
          <LegendRow key={category.name} category={category} max={context.maxTokens} onHover={setHovered} />
        ))}
      </ul>
      {deferred.length > 0 && (
        <p className="cp-note">
          Deferred (loaded on use, not counted):{" "}
          {deferred.map((category, index) => (
            <span key={category.name}>
              {index > 0 && ", "}
              {category.name} <span className="cp-mono">{formatTokens(category.tokens)}</span>
            </span>
          ))}
        </p>
      )}

      <Details sessionKey={sessionKey} context={context} />
    </>
  );
}

function Grid({ context, byName, hovered }: { context: ContextUsage; byName: Map<string, ContextCategory>; hovered?: string }) {
  const columns = Math.max(1, ...context.gridRows.map((row) => row.length));
  return (
    <div
      className="cp-grid"
      data-dense={columns > 12 ? "" : undefined}
      data-focus={hovered ? "" : undefined}
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
      role="img"
      aria-label={`Context window, ${Math.round(context.percentage)}% used`}
    >
      {context.gridRows.flatMap((row, y) =>
        row.map((square, x) => {
          const category = byName.get(square.categoryName);
          const style = categoryStyle(category);
          const fullness = Math.max(0, Math.min(1, square.squareFullness));
          return (
            <span
              key={`${y}:${x}`}
              className={`cp-sq${style.free ? " cp-sq-free" : ""}${style.hatched ? " cp-sq-hatched" : ""}`}
              data-on={hovered === square.categoryName ? "" : undefined}
              title={`${square.categoryName} · ${formatTokens(square.tokens)} (${square.percentage.toFixed(1)}%)`}
              style={{ "--cp-sq": style.color } as CSSProperties}
            >
              {!style.free && !style.hatched && <span className="cp-sq-fill" style={{ height: `${fullness * 100}%` }} />}
            </span>
          );
        }),
      )}
    </div>
  );
}

function LegendRow({ category, max, onHover }: { category: ContextCategory; max: number; onHover: (name: string | undefined) => void }) {
  const style = categoryStyle(category);
  return (
    <li className="cp-legend-row" onMouseEnter={() => onHover(category.name)}>
      <span className={`cp-swatch${style.hatched ? " cp-sq-hatched" : ""}${style.free ? " cp-swatch-free" : ""}`} style={{ "--cp-sq": style.color } as CSSProperties} />
      <span className="cp-legend-name">{category.name}</span>
      <span className="cp-legend-tokens">{formatTokens(category.tokens)}</span>
      <span className="cp-legend-percent">{formatPercent(category.tokens, max)}</span>
    </li>
  );
}

function Details({ sessionKey, context }: { sessionKey: string; context: ContextUsage }) {
  const home = homeDirectory();
  const open = (path: string) => {
    const paneId = getSession(sessionKey)?.paneId;
    if (paneId) openFile(path, { fromPaneId: paneId });
  };

  const servers = useMemo(() => {
    const groups = new Map<string, { tokens: number; tools: ContextUsage["mcpTools"] }>();
    for (const tool of context.mcpTools) {
      const group = groups.get(tool.serverName) ?? { tokens: 0, tools: [] };
      group.tokens += tool.tokens;
      group.tools.push(tool);
      groups.set(tool.serverName, group);
    }
    return [...groups.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  }, [context.mcpTools]);

  const sum = (values: { tokens: number }[]) => values.reduce((total, value) => total + value.tokens, 0);
  const skills = context.skills;
  const breakdown = context.messageBreakdown;

  return (
    <div className="cp-sections">
      <Section
        title="Memory files"
        defaultOpen
        empty={context.memoryFiles.length === 0}
        meta={<Meta count={context.memoryFiles.length} tokens={sum(context.memoryFiles)} />}
      >
        {context.memoryFiles.map((file) => (
          <button key={file.path} type="button" className="cp-item cp-item-button" title={`Open ${file.path}`} onClick={() => open(file.path)}>
            <span className="cp-item-name cp-mono" dir="rtl">
              <bdi>{tildePath(file.path, home)}</bdi>
            </span>
            <Badge>{file.type}</Badge>
            <span className="cp-item-tokens">{formatTokens(file.tokens)}</span>
          </button>
        ))}
      </Section>

      <Section title="MCP tools" empty={servers.length === 0} meta={<Meta count={context.mcpTools.length} tokens={sum(context.mcpTools)} />}>
        {servers.map(([server, group]) => (
          <div key={server} className="cp-group">
            <div className="cp-item cp-group-head">
              <span className="cp-item-name">{server}</span>
              <span className="cp-faint">{group.tools.length} tools</span>
              <span className="cp-item-tokens">{formatTokens(group.tokens)}</span>
            </div>
            {group.tools.map((tool) => (
              <div key={tool.name} className={`cp-item cp-item-nested${tool.isLoaded === false ? " cp-item-dim" : ""}`}>
                <span className="cp-item-name cp-mono">{tool.name.startsWith(`mcp__${server}__`) ? tool.name.slice(server.length + 7) : tool.name}</span>
                {tool.isLoaded === false && <span className="cp-faint">deferred</span>}
                <span className="cp-item-tokens">{formatTokens(tool.tokens)}</span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      {context.agents.length > 0 && (
        <Section title="Custom agents" meta={<Meta count={context.agents.length} tokens={sum(context.agents)} />}>
          {context.agents.map((agent) => (
            <div key={`${agent.source}:${agent.agentType}`} className="cp-item">
              <span className="cp-item-name cp-mono">{agent.agentType}</span>
              <Badge>{agent.pluginId ?? agent.source}</Badge>
              <span className="cp-item-tokens">{formatTokens(agent.tokens)}</span>
            </div>
          ))}
        </Section>
      )}

      <Section
        title="Skills"
        empty={!skills || skills.skillFrontmatter.length === 0}
        meta={
          skills && (
            <>
              <span className="cp-mono">
                {skills.includedSkills}/{skills.totalSkills}
              </span>
              <span className="cp-section-tokens">{formatTokens(skills.tokens)}</span>
            </>
          )
        }
      >
        {skills?.skillFrontmatter.map((skill) => (
          <div key={`${skill.pluginId ?? skill.source}:${skill.name}`} className="cp-item">
            <span className="cp-item-name cp-mono">{skill.name}</span>
            <Badge>{skill.pluginName ?? skill.source}</Badge>
            <span className="cp-item-tokens">{formatTokens(skill.tokens)}</span>
          </div>
        ))}
      </Section>

      <Section
        title="Messages"
        empty={!breakdown}
        meta={breakdown && <span className="cp-section-tokens">{formatTokens(context.categories.find((category) => category.id === "messages")?.tokens ?? 0)}</span>}
      >
        {breakdown && (
          <>
            <Breakdown label="Tool calls" tokens={breakdown.toolCallTokens} />
            <Breakdown label="Tool results" tokens={breakdown.toolResultTokens} />
            <Breakdown label="Assistant messages" tokens={breakdown.assistantMessageTokens} />
            <Breakdown label="User messages" tokens={breakdown.userMessageTokens} />
            <Breakdown label="Attachments" tokens={breakdown.attachmentTokens} />
            {breakdown.redirectedContextTokens > 0 && <Breakdown label="Redirected context" tokens={breakdown.redirectedContextTokens} />}
            {breakdown.unattributedTokens > 0 && <Breakdown label="Other" tokens={breakdown.unattributedTokens} />}
            {breakdown.toolCallsByType.length > 0 && (
              <>
                <div className="cp-subhead">
                  <span>By tool</span>
                  <span className="cp-subhead-cols">
                    <span>call</span>
                    <span>result</span>
                  </span>
                </div>
                {[...breakdown.toolCallsByType]
                  .sort((a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens))
                  .map((tool) => (
                    <div key={tool.name} className="cp-item cp-item-nested">
                      <span className="cp-item-name cp-mono">{tool.name}</span>
                      <span className="cp-item-tokens cp-faint">{formatTokens(tool.callTokens)}</span>
                      <span className="cp-item-tokens">{formatTokens(tool.resultTokens)}</span>
                    </div>
                  ))}
              </>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

function Meta({ count, tokens }: { count: number; tokens: number }) {
  return (
    <>
      <span className="cp-mono">{count}</span>
      <span className="cp-section-tokens">{formatTokens(tokens)}</span>
    </>
  );
}

function Breakdown({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div className="cp-item">
      <span className="cp-item-name">{label}</span>
      <span className="cp-item-tokens">{formatTokens(tokens)}</span>
    </div>
  );
}
