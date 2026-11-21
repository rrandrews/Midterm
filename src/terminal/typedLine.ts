/*
 * A rough model of what the user typed into the terminal since the last
 * command line was entered, from the keys xterm sends (`term.onData`).
 * Blocks mode uses it to tell typeahead on the shell's command line from
 * other text printed there (a background job's output): only text the
 * user typed is moved into the input editor (see docs/terminal.md,
 * "Typeahead").
 *
 * It follows plain typing only: printable characters append, DEL/⌃H
 * delete one, ⌃W a word, ⌃U and ⌃C clear, ⏎ and ⌃J start over, escape
 * sequences (arrows, focus reports, paste brackets) and other control keys
 * change nothing. After cursor movement or completion it no longer matches
 * what the shell shows, so nothing is adopted: the safe direction.
 */
export class TypedLine {
  private chars: string[] = [];

  get text(): string {
    return this.chars.join("");
  }

  reset(): void {
    this.chars = [];
  }

  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        i = skipEscape(data, i);
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\x15") this.chars = [];
      else if (ch === "\x7f" || ch === "\b") this.chars.pop();
      else if (ch === "\x17") this.deleteWord();
      else if (code >= 0x20) this.chars.push(ch);
      i++;
    }
  }

  private deleteWord(): void {
    while (this.chars.length && this.chars[this.chars.length - 1] === " ") this.chars.pop();
    while (this.chars.length && this.chars[this.chars.length - 1] !== " ") this.chars.pop();
  }
}

/** Index just past the escape sequence starting at `start` (CSI, SS3, OSC, or ESC + one char). */
function skipEscape(data: string, start: number): number {
  const next = data[start + 1];
  if (next === undefined) return start + 1;
  if (next === "[") {
    let i = start + 2;
    while (i < data.length) {
      const code = data.charCodeAt(i);
      i++;
      if (code >= 0x40 && code <= 0x7e) break;
    }
    return i;
  }
  if (next === "]") {
    let i = start + 2;
    while (i < data.length) {
      if (data[i] === "\x07") return i + 1;
      if (data[i] === "\x1b" && data[i + 1] === "\\") return i + 2;
      i++;
    }
    return i;
  }
  if (next === "O") return Math.min(data.length, start + 3);
  return start + 2;
}
