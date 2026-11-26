// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as aiIpc from "../ipc/ai";
import * as scmIpc from "../ipc/scm";
import type { ScmCommit, ScmDiff, ScmStatus } from "../ipc/scm";
import { resetScmMock } from "../ipc/scmMock";
import { DEFAULT_SETTINGS, type AiProfile } from "../settings/schema";
import { SettingsScopeProvider } from "../settings/scope";
import { settingsFor, useSettings } from "../settings/settings";
import {
  buildCommitMessageContext,
  cleanGeneratedCommitMessage,
  COMMIT_PROMPT_SETTING_KEY,
  DEFAULT_COMMIT_PROMPT,
  isCustomCommitPrompt,
  MAX_PROMPT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  resolveCommitPrompt,
} from "./commitMessage";
import { ScmModel } from "./model";
import { ScmSettingsSection } from "./ScmSettingsSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeProfile(overrides: Partial<AiProfile> = {}): AiProfile {
  return {
    id: "p-main",
    name: "Claude Sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    baseUrl: "",
    cliPath: "",
    ...overrides,
  };
}

function makeStatus(overrides: Partial<ScmStatus> = {}): ScmStatus {
  return {
    root: "/repo",
    gitDir: "/repo/.git",
    branch: "feat/commit-gen",
    headOid: "abcdef1234567890",
    upstream: "origin/feat/commit-gen",
    ahead: 1,
    behind: 0,
    state: "normal",
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

function makeCommit(subject: string, hash = "1111111"): ScmCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: [],
    subject,
    body: "",
    author: "Dev",
    email: "dev@example.com",
    date: Math.floor(Date.now() / 1000) - 60,
    refs: [],
  };
}

function makeDiff(path: string, lines: { kind: "context" | "add" | "del"; content: string }[]): ScmDiff {
  return {
    path,
    binary: false,
    isNew: false,
    isDeleted: false,
    tooLarge: false,
    nonUtf8: false,
    patchable: true,
    hunks: [
      {
        header: "@@ -1,1 +1,2 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: lines.map((l, i) => ({ ...l, oldLine: i + 1, newLine: i + 1 })),
      },
    ],
  };
}

function resetSettingsStore() {
  useSettings.setState({
    ...DEFAULT_SETTINGS,
    base: DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, profiles: [], defaultProfile: "", features: {} },
    plugins: {},
  });
}

describe("commitMessage helpers", () => {
  beforeEach(resetSettingsStore);
  afterEach(() => {
    vi.restoreAllMocks();
    resetSettingsStore();
  });

  it("resolves default and custom prompts accurately", () => {
    expect(resolveCommitPrompt()).toBe(DEFAULT_COMMIT_PROMPT);
    expect(isCustomCommitPrompt()).toBe(false);

    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "Use gitmoji prefixes.",
    });
    expect(resolveCommitPrompt()).toBe("Use gitmoji prefixes.");
    expect(isCustomCommitPrompt()).toBe(true);

    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "   ",
    });
    expect(resolveCommitPrompt()).toBe(DEFAULT_COMMIT_PROMPT);
    expect(isCustomCommitPrompt()).toBe(false);
  });

  it("cleans markdown fences, outer quotes, and CRLF line endings", () => {
    expect(cleanGeneratedCommitMessage("```text\r\nfeat(scm): add generator\r\n```")).toBe(
      "feat(scm): add generator",
    );
    expect(cleanGeneratedCommitMessage('"fix: trim trailing space"')).toBe("fix: trim trailing space");
    expect(cleanGeneratedCommitMessage("`chore: update deps`")).toBe("chore: update deps");
    expect(cleanGeneratedCommitMessage("feat: add API\r\n\r\n- wire endpoint\r\n- add tests")).toBe(
      "feat: add API\n\n- wire endpoint\n- add tests",
    );
  });

  it("prefers staged changes over unstaged changes and falls back to unstaged/untracked or amend HEAD", async () => {
    const fetchDiff = vi.fn(async (_root: string, path: string) =>
      makeDiff(path, [{ kind: "add", content: `updated ${path}` }]),
    );
    const fetchCommitFiles = vi.fn(async () => [{ path: "src/old.ts", status: "M" as const, binary: false }]);

    // Staged takes priority over unstaged.
    const stagedCtx = await buildCommitMessageContext({
      status: makeStatus({
        staged: [{ path: "src/staged.ts", status: "M" }],
        unstaged: [{ path: "src/unstaged.ts", status: "M" }],
      }),
      commits: [makeCommit("feat(scm): previous commit")],
      amend: false,
      fetchDiff,
      fetchCommitFiles,
    });
    expect(stagedCtx).toContain("Scope: Staged changes");
    expect(stagedCtx).toContain("src/staged.ts");
    expect(stagedCtx).not.toContain("src/unstaged.ts");
    expect(stagedCtx).toContain("feat(scm): previous commit");

    // Falls back to unstaged + untracked when nothing staged.
    fetchDiff.mockClear();
    const workingCtx = await buildCommitMessageContext({
      status: makeStatus({
        unstaged: [{ path: "src/app.ts", status: "M" }],
        untracked: [{ path: "src/new.ts", status: "A" }],
      }),
      commits: [],
      amend: false,
      fetchDiff,
      fetchCommitFiles,
    });
    expect(workingCtx).toContain("Working tree changes");
    expect(workingCtx).toContain("src/app.ts");
    expect(workingCtx).toContain("src/new.ts");

    // Amend uses HEAD baseline (plus staged changes), NEVER unstaged/untracked working-tree files.
    fetchDiff.mockClear();
    fetchCommitFiles.mockClear();
    const amendCtx = await buildCommitMessageContext({
      status: makeStatus({
        unstaged: [{ path: "src/unrelated-unstaged.ts", status: "M" }],
        untracked: [{ path: "src/unrelated-untracked.ts", status: "A" }],
      }),
      commits: [],
      amend: true,
      fetchDiff,
      fetchCommitFiles,
    });
    expect(amendCtx).toContain("Amending HEAD (abcdef1)");
    expect(amendCtx).toContain("src/old.ts");
    expect(amendCtx).not.toContain("src/unrelated-unstaged.ts");
    expect(amendCtx).not.toContain("src/unrelated-untracked.ts");
    expect(fetchCommitFiles).toHaveBeenCalledWith("/repo", "abcdef1234567890");

    // Amend with staged changes includes BOTH HEAD baseline and staged amend diffs, even for the same file.
    fetchDiff.mockClear();
    const amendWithStaged = await buildCommitMessageContext({
      status: makeStatus({
        staged: [
          { path: "src/old.ts", status: "M" },
          { path: "src/added.ts", status: "A" },
        ],
        unstaged: [{ path: "src/still-ignored.ts", status: "M" }],
      }),
      commits: [],
      amend: true,
      fetchDiff,
      fetchCommitFiles,
    });
    expect(amendWithStaged).toContain("Amending HEAD (abcdef1) with staged changes");
    expect(amendWithStaged).toContain("src/old.ts (HEAD)");
    expect(amendWithStaged).toContain("src/old.ts (staged amend)");
    expect(amendWithStaged).toContain("src/added.ts (staged amend)");
    expect(amendWithStaged).not.toContain("src/still-ignored.ts");
    // Both HEAD's commit diff and staged diff were fetched for src/old.ts.
    expect(fetchDiff).toHaveBeenCalledWith("/repo", "src/old.ts", "commit", {
      commitHash: "abcdef1234567890",
      oldPath: undefined,
    });
    expect(fetchDiff).toHaveBeenCalledWith("/repo", "src/old.ts", "staged", {
      commitHash: undefined,
      oldPath: undefined,
    });

    // Returns null when completely clean and not amending.
    const emptyCtx = await buildCommitMessageContext({
      status: makeStatus(),
      commits: [],
      amend: false,
      fetchDiff,
      fetchCommitFiles,
    });
    expect(emptyCtx).toBeNull();
  });

  it("omits lockfile diffs, redacts quoted JSON secrets, branch names, and paths, and enforces MAX_PROMPT_CHARS", async () => {
    const secretLine = '  "password": "ordinary-non-token-pass",';
    const tokenLine = "const API_KEY = 'sk-proj-1234567890abcdef1234567890abcdef';";
    const fetchDiff = vi.fn(async (_root: string, path: string) =>
      makeDiff(path, [
        { kind: "add", content: secretLine },
        { kind: "add", content: tokenLine },
        { kind: "add", content: "x".repeat(7000) },
      ]),
    );

    const ctx = await buildCommitMessageContext({
      status: makeStatus({
        branch: "feat/ghp_abcdefghijklmnopqrstuvwxyz0123",
        staged: [
          {
            path: "src/config-sk-ant-api03-abcdefghijklmnopqrstuv.json",
            origPath: "src/old-glpat-1234567890abcdefghij.json",
            status: "R",
          },
          { path: "bun.lock", status: "M" },
        ],
      }),
      commits: [makeCommit("y".repeat(30_000))],
      amend: false,
      fetchDiff,
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(ctx).toContain("bun.lock");
    expect(ctx).toContain("1 lockfile/minified file diff(s) omitted");
    expect(fetchDiff).toHaveBeenCalledTimes(1);
    expect(ctx).not.toContain("ordinary-non-token-pass");
    expect(ctx).not.toContain("sk-proj-1234567890abcdef1234567890abcdef");
    expect(ctx).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(ctx).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuv");
    expect(ctx).not.toContain("glpat-1234567890abcdefghij");
    expect(ctx).toContain("(file diff truncated)");

    // Huge changesets also stay strictly within MAX_PROMPT_CHARS.
    const hugeFiles = Array.from({ length: 1200 }, (_, i) => ({
      path: `src/packages/module-${i}/subpath/very-long-component-name-${i}.tsx`,
      status: "M" as const,
    }));
    const hugeCtx = await buildCommitMessageContext({
      status: makeStatus({ staged: hugeFiles }),
      commits: [],
      amend: false,
      fetchDiff,
    });
    expect(hugeCtx).not.toBeNull();
    expect(hugeCtx!.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(hugeCtx).toContain("more file(s) omitted");
  });

  it("stops issuing sequential diff fetches as soon as shouldAbort returns true", async () => {
    let aborted = false;
    const fetchDiff = vi.fn(async (_root: string, path: string) => {
      aborted = true;
      return makeDiff(path, [{ kind: "add", content: "line" }]);
    });

    const ctx = await buildCommitMessageContext({
      status: makeStatus({
        staged: [
          { path: "src/a.ts", status: "M" },
          { path: "src/b.ts", status: "M" },
          { path: "src/c.ts", status: "M" },
        ],
      }),
      commits: [],
      amend: false,
      shouldAbort: () => aborted,
      fetchDiff,
    });

    expect(ctx).toBeNull();
    expect(fetchDiff).toHaveBeenCalledTimes(1);
  });

  it("redacts multiline JSON/dotenv passwords, PEM keys, and omits source text from hunk headers", async () => {
    const fetchDiff = vi.fn(async (_root: string, path: string) => {
      const diff = makeDiff(path, [
        { kind: "context", content: '  "password":' },
        { kind: "del", content: '    "old-multiline-pass"' },
        { kind: "add", content: '    "new-multiline-pass"' },
        { kind: "add", content: 'PASSWORD="dotenv-first-line' },
        { kind: "add", content: 'dotenv-second-line"' },
        { kind: "context", content: "-----BEGIN PRIVATE KEY-----" },
        { kind: "add", content: "SUPERSECRETPEMBODYLINE123456" },
        { kind: "context", content: "-----END PRIVATE KEY-----" },
      ]);
      diff.hunks[0].header = "@@ -1,1 +1,2 @@ const SECRET_IN_HEADER = 'super-secret-header-val'";
      return diff;
    });

    const ctx = await buildCommitMessageContext({
      status: makeStatus({ staged: [{ path: "config.json", status: "M" }] }),
      commits: [],
      amend: false,
      fetchDiff,
    });

    expect(ctx).not.toBeNull();
    expect(ctx).not.toContain("old-multiline-pass");
    expect(ctx).not.toContain("new-multiline-pass");
    expect(ctx).not.toContain("dotenv-first-line");
    expect(ctx).not.toContain("dotenv-second-line");
    expect(ctx).not.toContain("SUPERSECRETPEMBODYLINE123456");
    expect(ctx).not.toContain("super-secret-header-val");
    expect(ctx).toContain("@@ -1,1 +1,2 @@");
    expect(ctx).toContain("-    [redacted]");
    expect(ctx).toContain("+    [redacted]");
  });

  it("masks a context line completely when old and new sides redact it differently", async () => {
    const fetchDiff = vi.fn(async (_root: string, path: string) =>
      makeDiff(path, [
        { kind: "add", content: 'PASSWORD="' },
        { kind: "context", content: "private text TOKEN=secret123" },
        { kind: "add", content: '"' },
      ]),
    );

    const ctx = await buildCommitMessageContext({
      status: makeStatus({ staged: [{ path: "config.txt", status: "M" }] }),
      commits: [],
      amend: false,
      fetchDiff,
    });

    expect(ctx).not.toBeNull();
    expect(ctx).not.toContain("private text");
    expect(ctx).not.toContain("secret123");
    expect(ctx).toContain(" [redacted]");
  });

  it("omits sensitive secret/key files and masks mid-file YAML block scalars & orphan PEM tails", async () => {
    const fetchDiff = vi.fn(async (_root: string, path: string) => {
      if (path.endsWith(".yaml")) {
        const diff = makeDiff(path, [
          { kind: "context", content: "    mid-block-old-secret" },
          { kind: "add", content: "    mid-block-new-secret" },
          { kind: "context", content: "  host: db.internal" },
        ]);
        diff.hunks[0].oldStart = 20;
        diff.hunks[0].newStart = 20;
        return diff;
      }
      const pemDiff = makeDiff(path, [
        { kind: "context", content: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD1111111111111" },
        { kind: "add", content: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD2222222222222" },
        { kind: "context", content: "-----END RSA PRIVATE KEY-----" },
      ]);
      pemDiff.hunks[0].oldStart = 12;
      pemDiff.hunks[0].newStart = 12;
      return pemDiff;
    });

    const ctx = await buildCommitMessageContext({
      status: makeStatus({
        staged: [
          { path: ".env.production", status: "M" },
          { path: "certs/server.pem", status: "M" },
          { path: "deploy/config.yaml", status: "M" },
          { path: "fixtures/embedded.txt", status: "M" },
        ],
      }),
      commits: [],
      amend: false,
      fetchDiff,
    });

    expect(ctx).not.toBeNull();
    expect(ctx).toContain("2 sensitive/secret file diff(s) omitted");
    expect(fetchDiff).toHaveBeenCalledTimes(2);
    expect(ctx).not.toContain("mid-block-old-secret");
    expect(ctx).not.toContain("mid-block-new-secret");
    expect(ctx).toContain("  host: db.internal");
    expect(ctx).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD1111111111111");
    expect(ctx).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD2222222222222");
  });
});

describe("ScmModel.generateCommitMessage", () => {
  beforeEach(() => {
    resetSettingsStore();
    resetScmMock("/Users/dev/project", true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSettingsStore();
  });

  it("sets an actionable settings error when no AI model is configured", async () => {
    const model = new ScmModel("scm-gen-1", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    await model.generateCommitMessage();

    expect(model.snapshot().generatingCommitMessage).toBe(false);
    expect(model.snapshot().error).toContain("Add a model first");
    expect(model.snapshot().errorAction).toBe("open-scm-settings");
    model.dispose();
  });

  it("streams a generated commit message using the configured commit model and custom prompt", async () => {
    const p1 = makeProfile({ id: "p-default", name: "Default Model", model: "claude-haiku-4-5" });
    const p2 = makeProfile({ id: "p-commit", name: "Commit Model", model: "claude-sonnet-4-5" });
    useSettings.getState().updateAi({
      profiles: [p1, p2],
      defaultProfile: p1.id,
      features: { commit: p2.id },
    });
    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "Write conventional commits only.",
    });

    const streamSpy = vi.spyOn(aiIpc, "aiStream").mockImplementation(async (request, onDelta) => {
      expect(request.target.model).toBe("claude-sonnet-4-5");
      expect(request.system).toBe("Write conventional commits only.");
      expect(request.prompt).toContain("Staged changes");
      onDelta("feat(scm): ");
      onDelta("add commit generator");
      return {
        text: "```text\nfeat(scm): add commit generator\n```",
        stop: "end",
        effortDropped: false,
      };
    });

    const model = new ScmModel("scm-gen-2", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    await model.generateCommitMessage();

    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(model.snapshot().generatingCommitMessage).toBe(false);
    expect(model.snapshot().error).toBeNull();
    expect(model.snapshot().commitMessage).toBe("feat(scm): add commit generator");
    model.dispose();
  });

  it("cancels an in-flight generation when triggered again or when user edits manually", async () => {
    const p1 = makeProfile();
    useSettings.getState().updateAi({ profiles: [p1], defaultProfile: p1.id, features: {} });

    let rejectStream: ((err: aiIpc.AiError) => void) | null = null;
    vi.spyOn(aiIpc, "aiStream").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStream = reject;
        }),
    );
    const cancelSpy = vi.spyOn(aiIpc, "aiCancel").mockImplementation(async () => {
      rejectStream?.({ kind: "cancelled", message: "Cancelled" });
    });

    const model = new ScmModel("scm-gen-3", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });
    model.setCommitMessage("existing draft");

    const pending = model.generateCommitMessage();
    // Let buildCommitMessageContext resolve and start aiStream.
    await new Promise((r) => setTimeout(r, 20));
    expect(model.snapshot().generatingCommitMessage).toBe(true);

    // Calling generateCommitMessage again acts as Stop.
    await model.generateCommitMessage();
    await pending;

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(model.snapshot().generatingCommitMessage).toBe(false);
    expect(model.snapshot().commitMessage).toBe("existing draft");
    expect(model.snapshot().error).toBeNull();
    model.dispose();
  });

  it("rejects commit() while streaming, pins target/prompt across settings changes, and flags token-limit truncation", async () => {
    const p1 = makeProfile({ id: "p-orig", name: "Orig", model: "orig-model" });
    const p2 = makeProfile({ id: "p-other", name: "Other", model: "other-model" });
    useSettings.getState().updateAi({ profiles: [p1, p2], defaultProfile: p1.id, features: { commit: p1.id } });
    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "Pinned prompt A",
    });

    let resolveStream!: (reply: aiIpc.StreamReply) => void;
    let capturedModel = "";
    let capturedSystem = "";
    vi.spyOn(aiIpc, "aiStream").mockImplementation(async (request, onDelta) => {
      capturedModel = request.target.model;
      capturedSystem = request.system;
      onDelta("feat(scm): partial message");
      return new Promise((resolve) => {
        resolveStream = resolve;
      });
    });

    const model = new ScmModel("scm-gen-4", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    // Start generating, then immediately mutate active settings (simulating workspace switch during diff fetch).
    const genPromise = model.generateCommitMessage();
    useSettings.getState().updateAi({ features: { commit: p2.id } });
    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "Other workspace prompt B",
    });

    await new Promise((r) => setTimeout(r, 25));
    expect(capturedModel).toBe("orig-model");
    expect(capturedSystem).toBe("Pinned prompt A");
    expect(model.snapshot().generatingCommitMessage).toBe(true);

    // Invoking commit() while streaming must be refused without cancelling or committing partial text.
    const commitCountBefore = model.snapshot().commits.length;
    await model.commit();
    expect(model.snapshot().generatingCommitMessage).toBe(true);
    expect(model.snapshot().commits.length).toBe(commitCountBefore);
    expect(model.snapshot().error).toContain("finish or stop");

    // Finish with stop: "length" — preserves draft AND warns user that it was cut off.
    resolveStream({ text: "feat(scm): truncated draft", stop: "length", effortDropped: false });
    await genPromise;

    expect(model.snapshot().generatingCommitMessage).toBe(false);
    expect(model.snapshot().commitMessage).toBe("feat(scm): truncated draft");
    expect(model.snapshot().error).toContain("token limit");
    model.dispose();
  });

  it("invalidates in-flight generation when Git context changes (e.g. toggling Amend or staging changes)", async () => {
    const p1 = makeProfile();
    useSettings.getState().updateAi({ profiles: [p1], defaultProfile: p1.id, features: {} });

    let rejectStream: ((err: aiIpc.AiError) => void) | null = null;
    vi.spyOn(aiIpc, "aiStream").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStream = reject;
        }),
    );
    const cancelSpy = vi.spyOn(aiIpc, "aiCancel").mockImplementation(async () => {
      rejectStream?.({ kind: "cancelled", message: "Cancelled" });
    });

    // Toggling Amend after streaming partial text automatically invalidates AND restores pre-generation draft!
    const model = new ScmModel("scm-gen-5", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });
    model.setCommitMessage("original user draft");

    let emitDelta!: (text: string) => void;
    vi.spyOn(aiIpc, "aiStream").mockImplementation((_req, onDelta) => {
      emitDelta = onDelta;
      return new Promise((_resolve, reject) => {
        rejectStream = reject;
      });
    });

    const pending = model.generateCommitMessage();
    await new Promise((r) => setTimeout(r, 25));
    emitDelta("stale partial stream text");
    await new Promise((r) => setTimeout(r, 25));
    expect(model.snapshot().generatingCommitMessage).toBe(true);
    expect(model.snapshot().commitMessage).toBe("stale partial stream text");

    // Toggling Amend cancels the stale stream AND restores the original pre-generation draft.
    model.setAmend(true);
    await pending;

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(model.snapshot().generatingCommitMessage).toBe(false);
    expect(model.snapshot().commitMessage).toBe("original user draft");
    model.dispose();
  });

  it("blocks generation while root is unresolved, rejects overly long prompts, and catches file content edits during streaming", async () => {
    const p1 = makeProfile();
    useSettings.getState().updateAi({ profiles: [p1], defaultProfile: p1.id, features: {} });

    const model = new ScmModel("scm-gen-6", { root: "/Users/dev/project" }, () => {});
    await model.refresh({ includeMeta: true });

    // Overly long custom prompt is rejected cleanly with settings link.
    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 10),
    });
    await model.generateCommitMessage();
    expect(model.snapshot().error).toContain("too long");
    expect(model.snapshot().errorAction).toBe("open-scm-settings");

    // Custom prompt within budget leaves room so system + prompt <= MAX_PROMPT_CHARS.
    const customPrompt = "P".repeat(2000);
    useSettings.getState().updatePluginSettings("source-control", {
      [COMMIT_PROMPT_SETTING_KEY]: customPrompt,
    });
    let resolveStream!: (reply: aiIpc.StreamReply) => void;
    let totalSentChars = 0;
    vi.spyOn(aiIpc, "aiStream").mockImplementation(async (request) => {
      totalSentChars = request.system.length + request.prompt.length;
      return new Promise((resolve) => {
        resolveStream = resolve;
      });
    });

    // Simulate a file content change during streaming (same path/status, different diff contents).
    let diffVersion = 1;
    vi.spyOn(scmIpc, "scmDiff").mockImplementation(async (_root, path) =>
      makeDiff(path, [{ kind: "add", content: `content version ${diffVersion}` }]),
    );

    model.setCommitMessage("before gen");
    const genPromise = model.generateCommitMessage();
    await new Promise((r) => setTimeout(r, 25));
    expect(totalSentChars).toBeLessThanOrEqual(MAX_PROMPT_CHARS);

    // Underlying file changes and a refresh runs while streaming.
    diffVersion = 2;
    await model.refresh({ includeMeta: false, silent: true, keepError: true });
    resolveStream({ text: "feat: stale message for v1", stop: "end", effortDropped: false });
    await genPromise;

    expect(model.snapshot().commitMessage).toBe("before gen");
    expect(model.snapshot().error).toContain("updated while generating");

    // Switching root puts model in rootPending until refresh resolves; generateCommitMessage is gated.
    model.setRoot("/other/repo");
    expect(model.snapshot().rootPending).toBe(true);
    const streamSpy = vi.spyOn(aiIpc, "aiStream");
    streamSpy.mockClear();
    await model.generateCommitMessage();
    expect(streamSpy).not.toHaveBeenCalled();

    model.dispose();
  });
});

describe("ScmSettingsSection", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    resetSettingsStore();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    resetSettingsStore();
  });

  it("prompts to open AI settings when no saved models exist and has zero native titles", async () => {
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ScmSettingsSection, { pluginId: "source-control" }));
    });

    expect(host.textContent).toContain("Commit message generation");
    expect(host.textContent).toContain("No saved models yet");
    expect(host.textContent).toContain("Open AI settings");

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message prompt"]');
    expect(textarea?.value).toBe(DEFAULT_COMMIT_PROMPT);

    const resetBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset to default"),
    );
    expect(resetBtn?.disabled).toBe(true);
    expect(host.querySelectorAll("[title]").length).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("edits custom prompt, avoids spurious writes on untouched blur, and resets back to default", async () => {
    const p1 = makeProfile({ id: "p-fast", name: "Fast Model" });
    const p2 = makeProfile({ id: "p-smart", name: "Smart Model" });
    useSettings.getState().updateAi({ profiles: [p1, p2], defaultProfile: p1.id, features: {} });

    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ScmSettingsSection, { pluginId: "source-control" }));
    });

    // Saved models dropdown trigger shows Default (Fast Model).
    expect(host.textContent).toContain("Default (Fast Model)");

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message prompt"]')!;
    // Focusing and blurring untouched default prompt does not store anything.
    await act(async () => {
      textarea.focus();
      textarea.blur();
    });
    expect(useSettings.getState().plugins["source-control"]?.settings?.[COMMIT_PROMPT_SETTING_KEY]).toBeUndefined();

    // Edit prompt via React-compatible input setter + focus/blur.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      textarea.focus();
      setter.call(textarea, "Always write one-line imperative commit subjects.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.blur();
    });

    expect(useSettings.getState().plugins["source-control"]?.settings?.[COMMIT_PROMPT_SETTING_KEY]).toBe(
      "Always write one-line imperative commit subjects.",
    );
    expect(host.textContent).toContain("Custom prompt active");

    // Click Reset to default.
    const resetBtn = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Reset to default"),
    )!;
    expect(resetBtn.disabled).toBe(false);
    await act(async () => {
      resetBtn.click();
    });

    expect(resolveCommitPrompt()).toBe(DEFAULT_COMMIT_PROMPT);
    expect(isCustomCommitPrompt()).toBe(false);
    expect(textarea.value).toBe(DEFAULT_COMMIT_PROMPT);
    expect(resetBtn.disabled).toBe(true);
    expect(host.querySelectorAll("[title]").length).toBe(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("only marks and resets the commit feature override in workspace scope and inherits future base changes", async () => {
    const p1 = makeProfile({ id: "p-a", name: "Model A" });
    const p2 = makeProfile({ id: "p-b", name: "Model B" });
    const p3 = makeProfile({ id: "p-c", name: "Model C" });
    useSettings.getState().updateAi({ profiles: [p1, p2, p3], defaultProfile: p1.id, features: { commit: p1.id } });
    // Workspace overrides ONLY `agent`, NOT `commit`.
    useSettings.getState().updateAi({ features: { agent: p2.id } }, "ws-1");

    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(
          SettingsScopeProvider,
          { value: "ws-1" },
          createElement(ScmSettingsSection, { pluginId: "source-control" }),
        ),
      );
    });

    // Commit row must NOT look overridden when only `agent` is overridden.
    expect(host.querySelector('button[aria-label="Use the default value"]')).toBeNull();
    expect(settingsFor("ws-1").ai.features.commit).toBe(p1.id);

    // Now override `commit` in ws-1 alongside `agent`.
    await act(async () => {
      useSettings.getState().updateAi({ features: { agent: p2.id, commit: p2.id } }, "ws-1");
    });
    const resetOverrideBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Use the default value"]');
    expect(resetOverrideBtn).not.toBeNull();

    // Clicking reset reverts ONLY `commit`, preserving `agent`!
    await act(async () => {
      resetOverrideBtn!.click();
    });
    const wsFeatures = useSettings.getState().base.workspaces["ws-1"]?.overrides.ai?.features;
    expect(wsFeatures?.commit).toBeUndefined();
    expect(wsFeatures?.agent).toBe(p2.id);

    // Changing the base commit model later must now be inherited live by ws-1!
    await act(async () => {
      useSettings.getState().updateAi({ features: { commit: p3.id } }, "default");
    });
    expect(settingsFor("ws-1").ai.features.commit).toBe(p3.id);
    expect(settingsFor("ws-1").ai.features.agent).toBe(p2.id);

    await act(async () => {
      root.unmount();
    });
  });
});
