/*
 * Number, time and path formatting for the Claude Code side panels. Pure, so
 * it is unit-tested (format.test.ts).
 */

/** 1234 → "1.2k", 1_234_567 → "1.2M"; small numbers stay whole. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  if (n < 10_000) return `${trim((n / 1000).toFixed(1))}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${trim((n / 1_000_000).toFixed(2))}M`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

function trim(fixed: string): string {
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** A cost in dollars: "$0.42", "$12.30", under a cent "<$0.01". */
export function formatCost(usd: number, currency = "USD"): string {
  if (usd > 0 && usd < 0.01) return currency === "USD" ? "<$0.01" : `<0.01 ${currency}`;
  const amount = usd.toFixed(2);
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

/** A duration: "840ms", "12s", "3m 05s", "2h 14m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms === 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A coarse time until `target` ("3h 12m", "2d 4h", "45m", "<1m"); "now" when past. */
export function formatUntil(target: number, now: number): string {
  const minutes = Math.floor((target - now) / 60_000);
  if (target - now <= 0) return "now";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** How long ago `time` was: "just now", "5m ago", "3h ago", "yesterday", "4d ago", else a date. */
export function formatAgo(time: number, now: number): string {
  const seconds = Math.floor((now - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** A whole percentage of a part ("34%"); "<1%" for a sliver. */
export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const percent = (part / whole) * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** `/Users/me/src` → `~/src` when under `home`. */
export function tildePath(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** "claude-opus-4-5-20251101" → "opus-4-5"; other ids unchanged. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[1m\]$/, " 1M");
}

/** The tone of a utilization (0-100) bar: `accent`, `warn` from 70%, `err` from 90%. */
export function usageTone(percent: number): "accent" | "warn" | "err" {
  if (percent >= 90) return "err";
  if (percent >= 70) return "warn";
  return "accent";
}
