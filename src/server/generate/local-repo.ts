import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { GithubData, SourceBlob } from "./github";
import {
  assembleSourceContext,
  type SourceContext,
  type SourceExcerpt,
} from "./source-context";
import {
  MAX_SOURCE_FILE_BYTES,
  maxSourceFiles,
  isArchitectureSource,
} from "./repository-context";

const README_NAMES = ["README.md", "readme.md", "README.rst", "README.txt"];

// Directories never worth walking. Git-tracked repos skip this entirely by
// deferring to `git ls-files`, which already honors .gitignore.
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
]);

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export interface LocalGitOrigin {
  /** Remote URL as git reports it, or null when there is no origin. */
  remoteUrl: string | null;
  /** Host owner/repo when the remote is a recognized forge, else null. */
  host: "github" | "gitlab" | null;
  owner: string | null;
  name: string | null;
  branch: string;
  /** Checked-out commit, so links point at what was actually read. */
  commit: string | null;
  dirty: boolean;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parses a git remote into forge coordinates. Handles both HTTPS and SSH
 * spellings, with or without a trailing .git.
 */
export function parseRemoteUrl(
  remoteUrl: string | null,
): Pick<LocalGitOrigin, "host" | "owner" | "name"> {
  const empty = { host: null, owner: null, name: null } as const;
  if (!remoteUrl) return empty;
  const match =
    /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
      remoteUrl.trim(),
    );
  if (!match) return empty;
  const [, hostname, owner, name] = match;
  const host = hostname?.includes("github.com")
    ? ("github" as const)
    : hostname?.includes("gitlab.com")
      ? ("gitlab" as const)
      : null;
  if (!host || !owner || !name) return empty;
  return { host, owner, name };
}

/** Reads origin, branch and commit so a local clone can produce real links. */
function readGitOrigin(root: string): LocalGitOrigin {
  const remoteUrl = git(root, ["remote", "get-url", "origin"]);
  const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain"]);
  return {
    remoteUrl,
    ...parseRemoteUrl(remoteUrl),
    // A detached HEAD reports "HEAD"; the commit is the usable ref then.
    branch: head && head !== "HEAD" ? head : (commit ?? "main"),
    commit,
    dirty: Boolean(status),
  };
}

/** Tracked files, honoring .gitignore. Returns null when not a git repo. */
function listTrackedFiles(root: string): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = output.split("\0").filter(Boolean);
    return paths.length ? paths : null;
  } catch {
    return null;
  }
}

function walkDirectory(root: string): string[] {
  const paths: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        paths.push(toPosix(relative(root, full)));
      }
    }
  }
  return paths;
}

async function readReadme(root: string): Promise<string> {
  for (const name of README_NAMES) {
    try {
      return await readFile(join(root, name), "utf8");
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * Builds the same struct the GitHub reader produces, from a directory on disk.
 * Nothing here touches the network. `sha` is a content sha256 rather than a
 * git blob hash: downstream code only checks its shape, and a content hash is
 * what a local run can verify anyway.
 */
export async function readLocalRepository(
  rootPath: string,
): Promise<GithubData & { rootPath: string; origin: LocalGitOrigin }> {
  const root = resolve(rootPath);
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory())
    throw new Error(`Not a directory: ${rootPath}`);

  const files = listTrackedFiles(root) ?? walkDirectory(root);
  if (!files.length) throw new Error(`No files found under ${rootPath}`);

  const pathTypes = new Map<string, "blob" | "tree">();
  const sourceBlobs = new Map<string, SourceBlob>();

  for (const path of files) {
    pathTypes.set(path, "blob");
    // Record every ancestor directory; selection and tree rendering both
    // expect "tree" entries the GitHub tree API would have supplied.
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++)
      pathTypes.set(segments.slice(0, i).join("/"), "tree");
  }

  for (const path of files) {
    if (!isArchitectureSource(path)) continue;
    try {
      const info = statSync(join(root, ...path.split("/")));
      if (!info.isFile() || info.size > MAX_SOURCE_FILE_BYTES) continue;
      const bytes = await readFile(join(root, ...path.split("/")));
      sourceBlobs.set(path, {
        sha: createHash("sha256").update(bytes).digest("hex"),
        size: info.size,
      });
    } catch {
      continue;
    }
  }

  const origin = readGitOrigin(root);
  return {
    rootPath: root,
    origin,
    // Real branch when this is a clone, so compiled links resolve.
    defaultBranch: origin.branch,
    fileTree: [...pathTypes.keys()].sort().join("\n"),
    readme: await readReadme(root),
    isPrivate: false,
    stargazerCount: null,
    pathTypes,
    sourceBlobs,
  };
}

/** Local stand-in for fetchSourceContext. Reads bodies from disk. */
export async function readLocalSourceContext(params: {
  rootPath: string;
  selectedPaths: string[];
}): Promise<SourceContext> {
  const paths = params.selectedPaths
    .filter(isArchitectureSource)
    .slice(0, maxSourceFiles());
  const available: SourceExcerpt[] = [];
  for (const path of paths) {
    try {
      const bytes = await readFile(
        join(params.rootPath, ...path.split("/")),
      );
      if (bytes.includes(0)) continue;
      available.push({
        path,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        truncated: false,
      });
    } catch {
      continue;
    }
  }
  return assembleSourceContext(available, paths.length);
}
