import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { spawnMockPty } from "./ptyMock";

/* Typed wrapper around the Rust PTY commands (src-tauri/src/pty). */

export type PtyExit = {
  /** `null` when the shell was ended by a signal. */
  code: number | null;
  /** How long the shell ran, as measured by the backend. */
  runtimeMs: number;
};

/** An environment variable for a new shell. */
export type PtyEnvVar = { name: string; value: string };

/**
 * A secret to put in the environment as `name`. The backend reads its value
 * from the key store (`account`, see `secrets.ts`); it never passes through
 * the webview.
 */
export type PtySecretVar = { name: string; account: string };

/**
 * The Python environment a new shell activates at its first prompt: a venv
 * directory, or the name of a conda environment.
 */
export type PtyPython = { kind: "venv" | "conda"; target: string };

export type PtyOptions = {
  cols: number;
  rows: number;
  /** Working directory; the home directory when omitted or missing. */
  cwd?: string;
  /** Program to run instead of the login shell (no shell integration then). */
  shell?: string;
  /** Arguments for `shell`. */
  shellArgs?: string[];
  /** Wrap `ssh` to load the shell integration on the remote (default true). */
  sshIntegration?: boolean;
  /** Per-PTY random secret token authenticating local OSC 6974 SSH handshakes. */
  sshToken?: string;
  /** Variables for the shell, on top of the terminal's own (applied in order). */
  env?: PtyEnvVar[];
  /**
   * Secrets for the shell's environment, after `env`. Call `warmSecrets` for
   * their accounts first, so that the spawn does not wait for a Keychain
   * prompt. Missing ones are skipped.
   */
  secrets?: PtySecretVar[];
  /** Python environment to activate (integrated shells), or `null`. */
  python?: PtyPython | null;
  /** Raw output bytes. May be called before `spawnPty` resolves. */
  onData: (bytes: Uint8Array) => void;
  /** Called once, after the last `onData`. */
  onExit: (exit: PtyExit) => void;
};

export type Pty = {
  write: (data: string) => void;
  /** Sends a "binary string" (one char per byte) without UTF-8 encoding it. */
  writeBinary: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /**
   * Reports that `bytes` of output have been processed. The backend stops
   * reading from the shell when too much output is unacknowledged.
   */
  ack: (bytes: number) => void;
  kill: () => void;
  /**
   * The process in the foreground of the terminal: the shell while it waits
   * at a prompt, otherwise the job it is running. `null` once the shell has
   * exited or when it cannot be determined.
   */
  foreground: () => Promise<PtyForeground | null>;
};

export type PtyForeground = {
  pid: number;
  /** Executable name, e.g. `zsh` or `vim`; empty if unknown. */
  name: string;
  /** True when the foreground process is the shell itself (nothing running). */
  isShell: boolean;
};

type PtyEvent = { event: "exit"; data: PtyExit };

function logFailure(command: string) {
  return (error: unknown) => console.error(`${command} failed:`, error);
}

async function spawnTauriPty(options: PtyOptions): Promise<Pty> {
  const onData = new Channel<ArrayBuffer | number[]>();
  onData.onmessage = (message) => {
    // Raw IPC bodies arrive as an ArrayBuffer; tolerate a JSON byte array too.
    options.onData(message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message));
  };

  const onEvent = new Channel<PtyEvent>();
  onEvent.onmessage = (message) => {
    if (message.event === "exit") options.onExit(message.data);
  };

  const id = await invoke<number>("pty_spawn", {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd ?? null,
    shell: options.shell || null,
    shellArgs: options.shell ? (options.shellArgs ?? []) : null,
    sshIntegration: options.sshIntegration ?? true,
    sshToken: options.sshToken ?? null,
    env: options.env?.length ? options.env : null,
    secrets: options.secrets?.length ? options.secrets : null,
    python: options.python ?? null,
    onData,
    onEvent,
  });

  return {
    write: (data) => void invoke("pty_write", { id, data }).catch(logFailure("pty_write")),
    writeBinary: (data) =>
      void invoke("pty_write_bytes", {
        id,
        data: Array.from(data, (char) => char.charCodeAt(0) & 0xff),
      }).catch(logFailure("pty_write_bytes")),
    resize: (cols, rows) =>
      void invoke("pty_resize", { id, cols, rows }).catch(logFailure("pty_resize")),
    ack: (bytes) => void invoke("pty_ack", { id, bytes }).catch(logFailure("pty_ack")),
    kill: () => void invoke("pty_kill", { id }).catch(logFailure("pty_kill")),
    foreground: () =>
      invoke<PtyForeground | null>("pty_foreground", { id }).catch((error: unknown) => {
        logFailure("pty_foreground")(error);
        return null;
      }),
  };
}

export async function spawnPty(options: PtyOptions): Promise<Pty> {
  return isTauri() ? spawnTauriPty(options) : spawnMockPty(options);
}
