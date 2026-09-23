/**
 * Drives the repo-diagram MCP over stdio from a JSON plan, so the server can
 * be exercised without an MCP client attached. Tool state (the bound file
 * selection) lives in the server process, so every call in a plan runs against
 * one spawned server.
 *
 *   bun run mcp/drive.mjs <plan.json> [out-dir]
 *
 * Plan: [{ "tool": "...", "args": {...}, "save": "file.json" }, ...]
 * "save" ending in .txt writes the payload's `source_excerpts` as plain text.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const planPath = process.argv[2];
const outDir = process.argv[3] ?? ".";
if (!planPath) {
  console.error("usage: bun run mcp/drive.mjs <plan.json> [out-dir]");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const child = spawn(
  process.execPath,
  [join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "server.ts")],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim().startsWith("{")) return;
  try {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  } catch {
    /* server logging */
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "drive", version: "0" },
});

for (const step of plan) {
  const result = await request("tools/call", {
    name: step.tool,
    arguments: step.args ?? {},
  });
  const payload = JSON.parse(result.content[0].text);
  const failed = result.isError === true;
  console.error(`${failed ? "ERROR" : "ok   "}  ${step.tool}`);
  if (failed) console.error(JSON.stringify(payload, null, 2).slice(0, 2000));

  if (step.save) {
    const target = join(outDir, step.save);
    if (step.save.endsWith(".txt")) {
      writeFileSync(target, payload.source_excerpts ?? JSON.stringify(payload), "utf8");
      const { source_excerpts, ...rest } = payload;
      writeFileSync(`${target}.meta.json`, JSON.stringify(rest, null, 2), "utf8");
    } else {
      writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
    }
    console.error(`       -> ${target}`);
  }
  if (failed) {
    child.kill();
    process.exit(1);
  }
}

child.kill();
