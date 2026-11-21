import { Gauge, RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PlanUsage } from "../../protocol";
import { request } from "../../client";
import { hasProcess, updateSession, useSession } from "../../store";
import type { SessionStatus, SessionTotals } from "../../types";
import { formatCost, formatDuration, formatTokens, formatUntil, shortModel, usageTone } from "./format";
import { Empty, ErrorLine, Heading, IconButton, Meter, Toolbar, errorText, useNow } from "./shared";

/*
 * Usage: this session's cost, time, lines and tokens per model, and the
 * plan's rate limits (5-hour, weekly, per model, extra usage) as bars.
 */

type ModelRow = { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export function UsagePanel({ sessionKey }: { sessionKey: string }) {
  const totals = useSession(sessionKey, (session) => session?.totals);
  const usage = useSession(sessionKey, (session) => session?.usage);
  const status = useSession(sessionKey, (session) => session?.status);
  const subscription = useSession(sessionKey, (session) => session?.init?.account?.subscriptionType);
  const live = status === "idle" || status === "running";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const now = useNow(60_000);

  const load = async () => {
    if (!hasProcess(sessionKey)) return;
    setLoading(true);
    setError(undefined);
    try {
      // Directly, not through refreshUsage, so a failure shows here.
      updateSession(sessionKey, { usage: await request("session.usage", { session: sessionKey }) });
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
    if (was === undefined || status === "idle") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const plan = usage?.subscription_type ?? subscription;
  const nothingYet = !usage && (!totals || totals.turns === 0);

  return (
    <>
      <Toolbar>
        <span className="cp-toolbar-text">{plan ? `${capitalize(plan)} plan` : live ? "API usage" : "Usage"}</span>
        <span className="cp-grow" />
        <IconButton label="Refresh" busy={loading} disabled={!live} onClick={() => void load()}>
          <RotateCw size={12} />
        </IconButton>
      </Toolbar>
      <div className="cp-body">
        {error && <ErrorLine onRetry={() => void load()}>{error}</ErrorLine>}
        {nothingYet && !live ? (
          <Empty icon={<Gauge size={18} />} title="Nothing used yet">
            Send a message to start the session; its cost and your plan limits appear here.
          </Empty>
        ) : (
          <>
            {totals && <SessionUsage totals={totals} usage={usage} />}
            {usage && <PlanLimits usage={usage} now={now} />}
          </>
        )}
      </div>
    </>
  );
}

function SessionUsage({ totals, usage }: { totals: SessionTotals; usage?: PlanUsage }) {
  const session = usage?.session;
  const cost = session?.total_cost_usd ?? totals.costUsd;
  const api = session?.total_api_duration_ms ?? totals.apiDurationMs;
  const wall = session?.total_duration_ms ?? totals.durationMs;
  const models: ModelRow[] = Object.entries(session?.model_usage ?? totals.byModel)
    .map(([model, use]) => ({
      model,
      input: use.inputTokens,
      output: use.outputTokens,
      cacheRead: use.cacheReadInputTokens,
      cacheWrite: use.cacheCreationInputTokens,
      cost: use.costUSD,
    }))
    .sort((a, b) => b.cost - a.cost);
  const tokens = models.reduce((sum, row) => sum + row.input + row.output + row.cacheRead + row.cacheWrite, 0);

  return (
    <>
      <Heading>This session</Heading>
      <div className="cp-stats">
        <Stat label="Cost" value={formatCost(cost)} strong />
        <Stat label="Turns" value={String(totals.turns)} />
        <Stat
          label="Lines"
          value={
            session ? (
              <>
                <span className="cp-ok">+{session.total_lines_added}</span> <span className="cp-err">−{session.total_lines_removed}</span>
              </>
            ) : (
              "—"
            )
          }
        />
        <Stat label="API time" value={formatDuration(api)} />
        <Stat label="Wall time" value={formatDuration(wall)} />
        <Stat label="Tokens" value={formatTokens(tokens)} />
      </div>

      {models.length > 0 && (
        <>
          <Heading>By model</Heading>
          <div className="cp-models">
            {models.map((row) => (
              <div key={row.model} className="cp-model">
                <div className="cp-model-head">
                  <span className="cp-mono cp-fg" title={row.model}>
                    {shortModel(row.model)}
                  </span>
                  <span className="cp-grow" />
                  <span className="cp-mono cp-fg">{formatCost(row.cost)}</span>
                </div>
                <div className="cp-model-cells">
                  <Cell label="In" value={row.input} />
                  <Cell label="Out" value={row.output} />
                  <Cell label="Cache read" value={row.cacheRead} />
                  <Cell label="Cache write" value={row.cacheWrite} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="cp-stat">
      <div className="cp-stat-label">{label}</div>
      <div className={`cp-stat-value${strong ? " cp-stat-strong" : ""}`}>{value}</div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: number }) {
  return (
    <div className="cp-cell">
      <span className="cp-cell-label">{label}</span>
      <span className="cp-cell-value">{formatTokens(value)}</span>
    </div>
  );
}

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

function PlanLimits({ usage, now }: { usage: PlanUsage; now: number }) {
  const limits = usage.rate_limits;
  if (!usage.rate_limits_available || !limits) {
    return (
      <>
        <Heading>Plan limits</Heading>
        <p className="cp-note">Plan limits don’t apply to this session (an API key or a cloud provider).</p>
      </>
    );
  }
  const rows: { label: string; window: Window }[] = [
    { label: "Current session", window: limits.five_hour },
    { label: "Weekly, all models", window: limits.seven_day },
    { label: "Weekly, Opus", window: limits.seven_day_opus },
    { label: "Weekly, Sonnet", window: limits.seven_day_sonnet },
    ...(limits.model_scoped ?? []).map((scoped) => ({ label: `Weekly, ${scoped.display_name}`, window: scoped })),
  ];
  const extra = limits.extra_usage;

  return (
    <>
      <Heading>Plan limits</Heading>
      <div className="cp-limits">
        {rows
          .filter((row) => row.window && row.window.utilization !== null)
          .map((row) => (
            <Limit key={row.label} label={row.label} window={row.window!} now={now} />
          ))}
        {extra && (
          <div className="cp-limit">
            <div className="cp-limit-head">
              <span className="cp-limit-label">Extra usage</span>
              {extra.is_enabled ? (
                <span className="cp-limit-value">
                  {extra.used_credits !== null ? formatCost(extra.used_credits, extra.currency ?? "USD") : "—"}
                  {extra.monthly_limit !== null && <span className="cp-faint"> / {formatCost(extra.monthly_limit, extra.currency ?? "USD")}</span>}
                </span>
              ) : (
                <span className="cp-faint">Off</span>
              )}
            </div>
            {extra.is_enabled && extra.utilization !== null && (
              <>
                <Meter percent={extra.utilization} tone={usageTone(extra.utilization)} label="Extra usage" />
                <div className="cp-limit-foot">Monthly limit</div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Limit({ label, window, now }: { label: string; window: NonNullable<Window>; now: number }) {
  const percent = window.utilization ?? 0;
  const resets = window.resets_at ? Date.parse(window.resets_at) : NaN;
  return (
    <div className="cp-limit">
      <div className="cp-limit-head">
        <span className="cp-limit-label">{label}</span>
        <span className={`cp-limit-value cp-text-${usageTone(percent)}`}>{Math.round(percent)}%</span>
      </div>
      <Meter percent={percent} tone={usageTone(percent)} label={label} />
      {Number.isFinite(resets) && (
        <div className="cp-limit-foot" title={new Date(resets).toLocaleString()}>
          {resets > now ? `Resets in ${formatUntil(resets, now)}` : "Resets now"}
        </div>
      )}
    </div>
  );
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
