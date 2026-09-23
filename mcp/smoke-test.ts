/**
 * Offline smoke test for the repo-diagram MCP. Speaks stdio JSON-RPC to the
 * server, runs the documented workflow against a real directory, and checks
 * that the honesty gate refuses an invented file path.
 *
 *   bun run mcp/smoke-test.ts <repo-path>
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const repoPath = process.argv[2] ?? process.cwd();
const child = spawn(
  process.execPath,
  [new URL("./server.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const pending = new Map<number, (value: unknown) => void>();
let nextId = 1;

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line) as { id?: number; result?: unknown };
    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)!(message.result);
      pending.delete(message.id);
    }
  } catch {
    // Non-JSON output is server logging; ignore.
  }
});

function request(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function call(name: string, args: Record<string, unknown> = {}) {
  return request("tools/call", { name, arguments: args });
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0" },
  });

  const tools = await request("tools/list", {});
  console.log(`\ntools/list -> ${tools.tools.length} tools`);
  for (const tool of tools.tools) console.log(`  ${tool.name}`);
  check("eight tools exposed", tools.tools.length === 8);

  console.log("\nworkflow:");
  const root = payload(await call("set_repo_root", { root_path: repoPath }));
  check("set_repo_root resolves", Boolean(root.root_path), JSON.stringify(root));
  console.log(
    `  root: ${root.total_paths} paths, ${root.candidate_sources} candidate sources`,
  );

  const structure = payload(await call("read_repo_structure", { max_paths: 20 }));
  check("read_repo_structure returns a tree", structure.file_tree?.length > 0);

  const sources = payload(
    await call("read_repo_sources", {
      max_files: 8,
      directory_diversity_penalty: 1,
    }),
  );
  check("read_repo_sources binds", sources.bound === true);
  check("respects max_files", sources.read_paths.length <= 8,
    `got ${sources.read_paths.length}`);
  console.log(`  read ${sources.read_paths.length} files, ${sources.characters_used} chars`);

  const contract = payload(await call("get_graph_contract"));
  check("contract exposes id pattern", Boolean(contract.id_pattern));

  // Honesty gate: a node pointing at a file that does not exist must be refused.
  const realPath = sources.read_paths[0];
  const invented = {
    groups: [{ id: "core", label: "Core", description: null }],
    nodes: [
      {
        id: "ghost",
        label: "Invented module",
        type: "component",
        description: null,
        groupId: "core",
        path: "src/this/file/does/not/exist.ts",
        shape: "box",
      },
    ],
    edges: [],
  };
  const refused = await call("validate_repo_graph", { graph: invented });
  check("invented path is refused", refused.isError === true,
    JSON.stringify(payload(refused)).slice(0, 200));

  // A graph whose paths are real should validate and compile.
  const honest = {
    groups: [{ id: "core", label: "Core", description: null }],
    nodes: [
      {
        id: "entry",
        label: "Entry point",
        type: "component",
        description: null,
        groupId: "core",
        path: realPath,
        shape: "box",
      },
      {
        id: "user",
        label: "User",
        type: "actor",
        description: null,
        groupId: null,
        path: null,
        shape: "circle",
      },
    ],
    edges: [
      { from: "user", to: "entry", label: "uses", description: null, style: "solid" },
    ],
  };
  const valid = await call("validate_repo_graph", { graph: honest });
  check("real path validates", !valid.isError,
    JSON.stringify(payload(valid)).slice(0, 300));

  if (!valid.isError) {
    const compiled = payload(await call("compile_repo_diagram", { graph: honest }));
    check("compiles to mermaid", compiled.mermaid?.startsWith("flowchart"));
    check("mermaid syntax valid", compiled.syntax_check?.valid === true,
      JSON.stringify(compiled.syntax_check));
    console.log("\n--- compiled ---");
    console.log(compiled.mermaid);
  }

  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  child.kill();
  process.exit(failures ? 1 : 0);
}

void main();
