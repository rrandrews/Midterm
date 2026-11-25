/** POSIX single-quote escaping for a shell argument (`'` → `'\''`); plain words stay as they are. */
export function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
