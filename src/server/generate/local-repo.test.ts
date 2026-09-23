import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRemoteUrl,
  readLocalRepository,
  readLocalSourceContext,
} from "./local-repo";

describe("parseRemoteUrl", () => {
  it("reads HTTPS GitHub remotes with and without .git", () => {
    expect(parseRemoteUrl("https://github.com/acme/widget.git")).toEqual({
      host: "github",
      owner: "acme",
      name: "widget",
    });
    expect(parseRemoteUrl("https://github.com/acme/widget")).toEqual({
      host: "github",
      owner: "acme",
      name: "widget",
    });
  });

  it("reads SSH remotes", () => {
    expect(parseRemoteUrl("git@github.com:acme/widget.git")).toEqual({
      host: "github",
      owner: "acme",
      name: "widget",
    });
  });

  it("recognizes GitLab separately", () => {
    expect(parseRemoteUrl("https://gitlab.com/group/project.git")).toEqual({
      host: "gitlab",
      owner: "group",
      name: "project",
    });
  });

  it("returns nulls for unrecognized or missing remotes", () => {
    const empty = { host: null, owner: null, name: null };
    expect(parseRemoteUrl(null)).toEqual(empty);
    expect(parseRemoteUrl("https://example.com/whatever")).toEqual(empty);
    expect(parseRemoteUrl("not a url")).toEqual(empty);
  });
});

function makeRepo(withGit: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "local-repo-test-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "src", "index.test.ts"), "// excluded\n");
  writeFileSync(join(root, "package.json"), '{"name":"t"}\n');
  writeFileSync(join(root, "README.md"), "# Test\n");
  if (withGit) {
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@example.com"]);
    run(["config", "user.name", "test"]);
    run(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
    run(["add", "-A"]);
    run(["commit", "-qm", "init"]);
  }
  return root;
}

describe("readLocalRepository", () => {
  it("reads a git clone's origin, branch and commit", async () => {
    const repo = await readLocalRepository(makeRepo(true));
    expect(repo.origin.host).toBe("github");
    expect(repo.origin.owner).toBe("acme");
    expect(repo.origin.name).toBe("widget");
    expect(repo.origin.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(repo.origin.dirty).toBe(false);
    expect(repo.defaultBranch).toBe(repo.origin.branch);
  });

  it("works on a plain directory with no git at all", async () => {
    const repo = await readLocalRepository(makeRepo(false));
    expect(repo.origin.host).toBeNull();
    expect(repo.origin.commit).toBeNull();
    expect(repo.pathTypes.has("src/index.ts")).toBe(true);
    expect(repo.readme).toContain("# Test");
  });

  it("excludes test files from source candidates", async () => {
    const repo = await readLocalRepository(makeRepo(false));
    expect(repo.sourceBlobs?.has("src/index.ts")).toBe(true);
    expect(repo.sourceBlobs?.has("src/index.test.ts")).toBe(false);
  });

  it("records ancestor directories as tree entries", async () => {
    const repo = await readLocalRepository(makeRepo(false));
    expect(repo.pathTypes.get("src")).toBe("tree");
    expect(repo.pathTypes.get("src/index.ts")).toBe("blob");
  });

  it("rejects a path that is not a directory", async () => {
    await expect(readLocalRepository(join(tmpdir(), "no-such-dir-xyz"))).rejects.toThrow();
  });
});

describe("readLocalSourceContext", () => {
  it("reads bodies from disk and marks them with FILE envelopes", async () => {
    const root = makeRepo(false);
    const repo = await readLocalRepository(root);
    const sources = await readLocalSourceContext({
      rootPath: repo.rootPath,
      selectedPaths: ["src/index.ts"],
    });
    expect(sources.paths).toEqual(["src/index.ts"]);
    expect(sources.text).toContain('FILE "src/index.ts"');
    expect(sources.text).toContain("export const x = 1;");
  });

  it("reports files it could not read rather than silently dropping them", async () => {
    const repo = await readLocalRepository(makeRepo(false));
    const sources = await readLocalSourceContext({
      rootPath: repo.rootPath,
      selectedPaths: ["src/index.ts", "src/missing.ts"],
    });
    expect(sources.paths).toEqual(["src/index.ts"]);
    expect(sources.unavailableCount).toBe(1);
  });
});

describe("nested repositories", () => {
  it("excludes a nested repo from a plain directory walk and names it", async () => {
    const root = makeRepo(false);
    const nested = join(root, "vendored");
    mkdirSync(nested);
    writeFileSync(join(nested, "lib.ts"), "export const nested = true;\n");
    execFileSync("git", ["init", "-q"], { cwd: nested, stdio: "ignore" });

    const repo = await readLocalRepository(root);
    expect(repo.nestedRepositories).toEqual(["vendored"]);
    expect(repo.pathTypes.has("vendored/lib.ts")).toBe(false);
    expect(repo.pathTypes.has("src/index.ts")).toBe(true);
  });

  it("records the path prefix for a subdirectory of a repo", async () => {
    const root = makeRepo(true);
    const repo = await readLocalRepository(join(root, "src"));
    expect(repo.origin.pathPrefix).toBe("src/");
    expect(repo.origin.owner).toBe("acme");
  });

  it("uses an empty prefix at the repository root", async () => {
    const repo = await readLocalRepository(makeRepo(true));
    expect(repo.origin.pathPrefix).toBe("");
  });
});
