import type { TerminalBackground } from "./settings";

/*
 * When a transparent terminal gets a solid background anyway: full-screen
 * programs (alternate screen) and listed programs that paint their own
 * background colors, which clash with the pane gradient.
 */

/** The lowercase final path component. */
function baseName(path: string): string {
  return (path.split("/").pop() ?? "").trim().toLowerCase();
}

/**
 * Whether the foreground program `name` is one of `commands`: equal to an
 * entry (case-insensitive, any leading path in the entry ignored) or the
 * entry followed by `-`, as in `codex-aarch64-apple-darwin`.
 */
export function matchesForeground(name: string | undefined, commands: readonly string[]): boolean {
  const program = name ? baseName(name) : "";
  if (!program) return false;
  return commands.some((entry) => {
    const wanted = baseName(entry);
    return wanted !== "" && (program === wanted || program.startsWith(`${wanted}-`));
  });
}

export type SolidInputs = {
  terminalBackground: TerminalBackground;
  solidForFullscreen: boolean;
  solidBackgroundCommands: readonly string[];
  /** The alternate screen buffer is active. */
  alternateScreen: boolean;
  /** The terminal's foreground program name, if known. */
  foregroundName: string | undefined;
};

/** Whether the terminal should render with a solid background right now. */
export function effectiveSolid(input: SolidInputs): boolean {
  if (input.terminalBackground === "solid") return true;
  return (
    (input.solidForFullscreen && input.alternateScreen) ||
    matchesForeground(input.foregroundName, input.solidBackgroundCommands)
  );
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` as an xterm color report body (`rgb:rrrr/gggg/bbbb`), or null. */
export function oscColor(hex: string): string | null {
  let digits = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3,4}$/i.test(digits)) digits = [...digits].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(digits)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => digits.slice(i, i + 2).toLowerCase());
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}
