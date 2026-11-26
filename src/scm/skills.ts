import { scmBranches, scmDiff, scmLog, scmStatus, type ScmDiffMode } from "../ipc/scm";
import type { Skill } from "../plugins/types";

export const scmSkills: Skill[] = [
  {
    id: "git",
    title: "Git source control",
    description:
      "Inspect a repository's Git status, staged/unstaged/commit diffs, recent commit history, and branches (works on local and SSH repos).",
    tools: [
      {
        name: "status",
        description:
          "Returns branch, upstream ahead/behind counts, repository state (normal/merging/rebasing), and staged, unstaged, untracked, and conflicted files.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "Absolute local path or ssh://<id>/<path> inside the repository" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path } = input as { path: string };
          const status = await scmStatus(path);
          return status ?? { repository: false, path };
        },
      },
      {
        name: "diff",
        description: "Returns the structured unified diff hunks for a single repository-relative file.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "Repository path" },
            filePath: { type: "string", minLength: 1, description: "Repository-relative POSIX file path" },
            mode: { type: "string", enum: ["unstaged", "staged", "untracked", "commit", "stash"], default: "unstaged" },
            commitHash: { type: "string", description: "Commit hash (for mode='commit') or stash ref (for mode='stash')" },
            oldPath: { type: "string", description: "Previous relative path for renamed files" },
          },
          required: ["path", "filePath"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path, filePath, mode = "unstaged", commitHash, oldPath } = input as {
            path: string;
            filePath: string;
            mode?: ScmDiffMode;
            commitHash?: string;
            oldPath?: string;
          };
          return scmDiff(path, filePath, mode, { commitHash, oldPath });
        },
      },
      {
        name: "log",
        description: "Lists recent commits (hash, parents, author, date, subject, refs).",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "Repository path" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
            all: { type: "boolean", default: false },
          },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path, limit = 25, all = false } = input as { path: string; limit?: number; all?: boolean };
          return scmLog(path, { limit, skip: 0, all });
        },
      },
      {
        name: "branches",
        description: "Lists local and remote branches with tracking upstream, ahead/behind counts, and tip commits.",
        effect: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1, description: "Repository path" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        run: async (input) => {
          const { path } = input as { path: string };
          return scmBranches(path);
        },
      },
    ],
  },
];
