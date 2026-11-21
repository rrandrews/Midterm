import { completeList, pathCommands } from "../ipc/complete";
import { BUILTINS, type Candidate, type CompletionContext, filterCandidates } from "./completion";

/** Where the prompt is: what relative paths, `~` and command names resolve against. */
export type CompletionEnv = {
  /** The prompt's working directory; no path completion without it. */
  cwd: string | undefined;
  /** The home directory, for `~/`. */
  home: string | undefined;
  /** The shell's reported `PATH`; the app's own when unset. */
  path: string | undefined;
};

/**
 * The absolute directory `dir` (`~/x/`, `/x/`, `x/` or empty, as in
 * `CompletionContext.dir`) names, without a trailing slash except for `/`;
 * `undefined` if it cannot be resolved.
 */
export function resolveDir(dir: string, env: Pick<CompletionEnv, "cwd" | "home">): string | undefined {
  let absolute: string;
  if (dir.startsWith("/")) absolute = dir;
  else if (dir.startsWith("~/")) {
    if (!env.home) return undefined;
    absolute = env.home + dir.slice(1);
  } else {
    if (!env.cwd) return undefined;
    absolute = dir ? `${env.cwd.replace(/\/$/, "")}/${dir}` : env.cwd;
  }
  return absolute.length > 1 ? absolute.replace(/\/+$/, "") : absolute;
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
    const names = await pathCommands(env.path).catch(() => [] as string[]);
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
