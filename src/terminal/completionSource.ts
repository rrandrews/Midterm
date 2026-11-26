import { formatRemoteLocation, parseLocation, remoteIdOf } from "../files/location";
import { completeList, pathCommands } from "../ipc/complete";
import { BUILTINS, type Candidate, type CompletionContext, filterCandidates } from "./completion";

/** Where the prompt is: what relative paths, `~` and command names resolve against. */
export type CompletionEnv = {
  /** The prompt's working directory (local or `ssh://<id>/<path>`); no path completion without it. */
  cwd: string | undefined;
  /** The matching host's home directory, for `~/`. */
  home: string | undefined;
  /** The shell's reported `PATH`; the app's own when unset (local only). */
  path: string | undefined;
  /** Managed SSH remote id when completing on a remote host. */
  remoteId?: string | null;
};

/**
 * The absolute location `dir` (`~/x/`, `/x/`, `x/` or empty, as in
 * `CompletionContext.dir`) names, without a trailing slash except for `/`,
 * preserving any `ssh://<remoteId>` host prefix; `undefined` if it cannot be
 * resolved.
 */
export function resolveDir(dir: string, env: Pick<CompletionEnv, "cwd" | "home" | "remoteId">): string | undefined {
  const remoteId = env.remoteId ?? (env.cwd ? remoteIdOf(env.cwd) : null);
  let posix: string;
  if (dir.startsWith("/")) {
    posix = dir;
  } else if (dir.startsWith("~/")) {
    if (!env.home) return undefined;
    const homeParsed = parseLocation(env.home);
    if (!homeParsed) return undefined;
    if (remoteId && (homeParsed.kind !== "remote" || homeParsed.remoteId !== remoteId)) return undefined;
    posix = homeParsed.path === "/" ? dir.slice(1) : homeParsed.path + dir.slice(1);
  } else {
    if (!env.cwd) return undefined;
    const cwdParsed = parseLocation(env.cwd);
    if (!cwdParsed) return undefined;
    posix = dir ? `${cwdParsed.path.replace(/\/$/, "")}/${dir}` : cwdParsed.path;
  }
  const clean = posix.length > 1 ? posix.replace(/\/+$/, "") : posix;
  return remoteId ? formatRemoteLocation(remoteId, clean) : clean;
}

/** The candidates for `context`, filtered by what is typed. */
export async function findCandidates(
  context: CompletionContext,
  env: CompletionEnv,
): Promise<{ matches: Candidate[]; ignoreCase: boolean }> {
  if (context.dir === "~" && context.word.value === "~") {
    return { matches: [{ name: "~", dir: true }], ignoreCase: false };
  }
  let candidates: Candidate[];
  if (context.kind === "command") {
    const remoteId = env.remoteId ?? (env.cwd ? remoteIdOf(env.cwd) : null);
    const names = await pathCommands(env.path, remoteId ?? undefined).catch(() => [] as string[]);
    candidates = [...names, ...BUILTINS].map((name) => ({ name, dir: false }));
  } else {
    const dir = resolveDir(context.dir, env);
    if (!dir) return { matches: [], ignoreCase: false };
    const entries = await completeList(dir).catch(() => []);
    candidates = entries
      .filter((entry) =>
        context.kind === "dir" ? entry.dir : context.kind === "executable" ? entry.dir || entry.executable : true,
      )
      .map((entry) => ({ name: entry.name, dir: entry.dir }));
  }
  return filterCandidates(candidates, context.prefix);
}
