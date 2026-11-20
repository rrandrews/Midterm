import { MOCK_HOME } from "./fsMock";
import type { Pty, PtyOptions } from "./pty";

/*
 * Stand-in for a shell when the frontend runs in a plain browser (`bun run
 * dev` without Tauri), so layout and blocks mode can be worked on without
 * the native side. It speaks the same shell integration as the real
 * scripts (OSC 7, OSC 133 A/B/C/D) and knows a handful of commands:
 * `ls`, `cd`, `pwd`, `echo`, `git status`, `seq N`, `sleep N` (⌃C stops
 * it), `ask` (reads a line), `vim`/`less` (alternate screen, `q` quits),
 * `clear`, `true`, `false`, `exit [n]`, and `ssh <host>`, which starts a
 * pretend remote shell with its own aid and host (`exit` leaves it), like
 * the integration over ssh. Not a shell.
 */

const ESC = "\x1b";
const BEL = "\x07";
const dim = (text: string) => `${ESC}[38;2;133;138;150m${text}${ESC}[0m`;
const SGR = (code: string, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;
/** The pretend remote shell's home directory. */
const REMOTE_HOME = "/home/demo";

type Job = {
  /** Input while the job runs. */
  input: (char: string) => void;
  /** ⌃C. */
  interrupt: () => void;
};

export function spawnMockPty(options: PtyOptions): Pty {
  const encoder = new TextEncoder();
  const send = (text: string) => queueMicrotask(() => options.onData(encoder.encode(text)));
  const started = performance.now();
  let cwd = options.cwd ?? MOCK_HOME;
  let line = "";
  let job: Job | null = null;
  let exited = false;
  /** Unfinished escape sequence from the last write. */
  let pendingEscape = "";
  let pasting = false;
  /** The mock shell's `aid=`, like the real scripts'. */
  const localAid = `${Math.floor(Math.random() * 1e6)}.mock`;
  /** The pretend shell over `ssh host`, while one runs. */
  let remote: { host: string; aid: string; localCwd: string } | null = null;
  const mark = (payload: string) => `${ESC}]133;${payload};aid=${remote?.aid ?? localAid}${BEL}`;

  const home = () => (remote ? REMOTE_HOME : MOCK_HOME);
  const display = (path: string) => {
    const relative = path === home() || path.startsWith(`${home()}/`) ? `~${path.slice(home().length)}` : path;
    return remote ? `${remote.host}:${relative}` : relative;
  };
  const cwdReport = () => `${ESC}]7;file://${remote?.host ?? "localhost"}${encodeURI(cwd)}${BEL}`;
  const prompt = () => `${cwdReport()}${mark("A")}${dim(display(cwd))} ${SGR("38;2;139;156;255", "❯")} ${mark("B")}`;

  const finish = (code: number) => {
    job = null;
    send(`${mark(`D;${code}`)}${prompt()}`);
  };

  const resolve = (path: string) => {
    if (!path || path === "~") return home();
    if (path.startsWith("~/")) path = `${home()}${path.slice(1)}`;
    const parts = (path.startsWith("/") ? [] : cwd.split("/").filter(Boolean));
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return `/${parts.join("/")}`;
  };

  /** Runs one command line; returns its exit status, or `null` if it finishes later (a job). */
  const run = (commandLine: string): number | null => {
    const [command = "", ...args] = commandLine.trim().split(/\s+/);
    switch (command) {
      case "":
        return 0;
      case "true":
        return 0;
      case "false":
        return 1;
      case "pwd":
        send(`${cwd}\r\n`);
        return 0;
      case "echo":
        send(`${args.join(" ")}\r\n`);
        return 0;
      case "cd":
        cwd = resolve(args[0] ?? "~");
        return 0;
      case "ls":
        send(
          [
            SGR("1;34", "src") + "/",
            SGR("1;34", "src-tauri") + "/",
            "package.json",
            "README.md",
            SGR("32", "build.sh*"),
          ].join("   ") + "\r\n",
        );
        return 0;
      case "git":
        if (args[0] !== "status") {
          send(`git: '${args[0] ?? ""}' is not a git command in the mock\r\n`);
          return 1;
        }
        send(
          `## main...origin/main [ahead 2]\r\n${SGR("33", " M")} src/components/SplitNode.tsx\r\n${SGR("32", "??")} src/components/TitleBar.tsx\r\n`,
        );
        return 0;
      case "seq": {
        const n = Math.min(Number(args[0]) || 10, 100_000);
        let out = "";
        for (let i = 1; i <= n; i++) out += `${i}\r\n`;
        send(out);
        return 0;
      }
      case "clear":
        send(`${ESC}[H${ESC}[2J${ESC}[3J`);
        return 0;
      case "sleep": {
        let dots = 0;
        const ticker = setInterval(() => send(`${SGR("2", `tick ${++dots}`)}\r\n`), 500);
        const timer = setTimeout(() => {
          clearInterval(ticker);
          finish(0);
        }, (Number(args[0]) || 1) * 1000);
        job = {
          input: () => {},
          interrupt: () => {
            clearTimeout(timer);
            clearInterval(ticker);
            send("^C\r\n");
            finish(130);
          },
        };
        return null;
      }
      case "ask": {
        send("Your name? ");
        let answer = "";
        job = {
          input: (char) => {
            if (char === "\r") {
              send(`\r\nHello, ${answer || "stranger"}!\r\n`);
              finish(0);
            } else if (char === "\x7f") {
              if (answer) {
                answer = answer.slice(0, -1);
                send("\b \b");
              }
            } else if (char >= " ") {
              answer += char;
              send(char);
            }
          },
          interrupt: () => {
            send("^C\r\n");
            finish(130);
          },
        };
        return null;
      }
      case "vim":
      case "less": {
        send(`${ESC}[?1049h${ESC}[H${ESC}[2J${SGR("7", ` ${command} (mock) — press q to quit `)}\r\n\r\n${args.join(" ") || "nothing to see here"}`);
        const quit = () => {
          send(`${ESC}[?1049l`);
          finish(0);
        };
        job = { input: (char) => char === "q" && quit(), interrupt: () => {} };
        return null;
      }
      case "ssh": {
        const host = args.find((arg) => !arg.startsWith("-"));
        if (!host || args.length > 1 || remote) {
          send(`mock: only \`ssh <host>\` from the local shell\r\n`);
          return 255;
        }
        send(`Welcome to ${host} (mock)\r\n`);
        remote = { host, aid: `${Math.floor(Math.random() * 1e6)}.remote`, localCwd: cwd };
        cwd = REMOTE_HOME;
        // The local `ssh` command runs on; the remote shell prompts.
        send(prompt());
        return null;
      }
      case "exit":
        if (remote) {
          const { host, localCwd } = remote;
          send(`logout\r\nConnection to ${host} closed.\r\n`);
          remote = null;
          cwd = localCwd;
          finish(Number(args[0]) || 0);
          return null;
        }
        exited = true;
        send("\r\n");
        queueMicrotask(() => options.onExit({ code: Number(args[0]) || 0, runtimeMs: performance.now() - started }));
        return null;
      default:
        send(`mock: command not found: ${command}\r\n`);
        return 127;
    }
  };

  const accept = () => {
    const commandLine = line;
    line = "";
    send("\r\n");
    if (!commandLine.trim()) {
      send(prompt());
      return;
    }
    send(mark("C"));
    // A multi-line command line runs line by line; its status is the last one's.
    let status: number | null = 0;
    for (const part of commandLine.split("\n")) {
      if (job || exited) break;
      status = run(part);
    }
    if (status !== null && !job && !exited) finish(status);
  };

  const key = (char: string) => {
    if (job) {
      if (char === "\x03") job.interrupt();
      else job.input(char);
      return;
    }
    if (char === "\r" && !pasting) accept();
    else if (char === "\x03") {
      line = "";
      send(`^C\r\n${prompt()}`);
    } else if (char === "\x7f") {
      if (line) {
        line = line.slice(0, -1);
        send("\b \b");
      }
    } else if (char === "\r" || char === "\n") {
      line += "\n";
      send("\r\n> ");
    } else if (char >= " ") {
      line += char;
      send(char);
    }
  };

  // Bracketed paste on, like zsh and bash 5.1, then the first prompt.
  send(`${ESC}[?2004h${dim("[mock pty — run `bun run tauri dev` for a real shell]")}\r\n${prompt()}`);

  return {
    write: (data) => {
      if (exited) return;
      const text = pendingEscape + data;
      pendingEscape = "";
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== ESC) {
          key(text[i]);
          continue;
        }
        // Escape sequences: bracketed paste markers matter, the rest is ignored.
        const match = /^\x1b\[[0-9;?]*[@-~]/.exec(text.slice(i));
        if (!match) {
          if (text.length - i < 16 && (i + 1 >= text.length || text[i + 1] === "[")) pendingEscape = text.slice(i);
          if (pendingEscape) break;
          continue;
        }
        if (match[0] === `${ESC}[200~`) pasting = true;
        else if (match[0] === `${ESC}[201~`) pasting = false;
        i += match[0].length - 1;
      }
    },
    writeBinary: () => {},
    resize: () => {},
    ack: () => {},
    kill: () => {},
    // While the pretend remote shell runs, ssh has the terminal.
    foreground: async () => ({
      pid: 0,
      name: remote ? "ssh" : job ? "mock-job" : "mock",
      isShell: job === null && remote === null,
    }),
  };
}
