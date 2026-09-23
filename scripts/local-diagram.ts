/**
 * Generate a diagram from a directory on disk, with no GitHub, R2, Redis or
 * Next.js involvement. Drives the same generation modules the hosted service
 * uses, so depth and model are the only things that differ.
 *
 *   bun run scripts/local-diagram.ts <path> [--out <file>] [--files N]
 *
 * Environment:
 *   OPENAI_API_KEY / OPENROUTER_API_KEY   provider credentials
 *   OPENAI_BASE_URL                       any OpenAI-compatible endpoint
 *   OPENAI_MODEL / AI_PROVIDER            model selection
 *   GD_MAX_SOURCE_FILES                   files read (hosted default: 12)
 *   GD_MAX_SOURCE_CHARACTERS              prompt budget (hosted: 48000)
 *   GD_MAX_SOURCE_FILE_CHARACTERS         per-file cap (hosted: 10000)
 *   GD_DIRECTORY_DIVERSITY_PENALTY        spread vs depth (hosted: 5)
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  readLocalRepository,
  readLocalSourceContext,
} from "../src/server/generate/local-repo";
import {
  prepareRepositoryContext,
  selectAnalysisModel,
  maxSourceFiles,
  maxSourceCharacters,
} from "../src/server/generate/repository-context";
import {
  architectureOutputSchema,
  expandArchitectureGraph,
} from "../src/server/generate/architecture-output";
import {
  buildFileTreeLookup,
  compileDiagramGraph,
} from "../src/server/generate/graph";
import { generateValidatedGraph } from "../src/server/generate/graph-planner";
import { createGenerationSessionAudit } from "../src/server/generate/session-audit";
import { streamCompletion } from "../src/server/generate/openai";
import { getModel, getProvider } from "../src/server/generate/model-config";
import {
  SYSTEM_ARCHITECTURE_PROMPT,
  SYSTEM_FIRST_PROMPT,
} from "../src/server/generate/prompts";
import { toTaggedMessage } from "../src/server/generate/format";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }
  return { rootPath: positional[0], flags };
}

async function main() {
  const { rootPath, flags } = parseArgs(process.argv.slice(2));
  if (!rootPath) {
    console.error("usage: bun run scripts/local-diagram.ts <path> [--out f]");
    process.exit(1);
  }
  if (flags.has("files")) process.env.GD_MAX_SOURCE_FILES = flags.get("files");

  const provider = getProvider();
  const model = getModel(provider);
  const analysisModel = selectAnalysisModel({ provider, model });

  console.error(`reading ${rootPath}`);
  const repo = await readLocalRepository(rootPath);
  const context = prepareRepositoryContext(repo);
  console.error(
    `tracked paths: ${repo.pathTypes.size}, candidate sources: ${repo.sourceBlobs?.size ?? 0}`,
  );

  const sources = await readLocalSourceContext({
    rootPath: repo.rootPath,
    selectedPaths: context.selectedPaths,
  });
  console.error(
    `reading ${sources.paths.length}/${maxSourceFiles()} files, ` +
      `${sources.text.length}/${maxSourceCharacters()} chars:`,
  );
  for (const path of sources.paths) console.error(`  ${path}`);

  const controller = new AbortController();
  let audit = createGenerationSessionAudit({
    sessionId: randomUUID(),
    provider,
    model,
  });

  // The hosted route runs a single architecture pass on its managed model and
  // a two-stage explanation-then-graph pass otherwise. Two-stage is the
  // portable path, so a pluggable endpoint uses it unconditionally.
  console.error(`\nexplanation stage (${analysisModel})...`);
  const explanationStream = await streamCompletion({
    provider,
    model: analysisModel,
    systemPrompt: SYSTEM_FIRST_PROMPT,
    userPrompt: toTaggedMessage({
      file_tree: context.fileTree,
      readme: context.readme,
      source_files: sources.text,
    }),
    signal: controller.signal,
  });
  let explanation = "";
  for await (const chunk of explanationStream.stream) {
    explanation += chunk;
    process.stderr.write(".");
  }
  console.error(`\nexplanation: ${explanation.length} chars`);
  if (!explanation.trim()) throw new Error("Explanation stage returned empty.");

  console.error(`graph stage (${model})...`);
  const graphResult = await generateValidatedGraph({
    provider,
    model,
    sessionId: audit.sessionId,
    explanation,
    fileTree: context.fileTree,
    fileTreeLookup: buildFileTreeLookup(repo.fileTree),
    signal: controller.signal,
    audit,
    complimentaryEstimate: null,
    accounting: {
      actualUsages: [],
      hasCompleteMeasuredUsage: true,
      completedUnmeasuredTokenEstimate: 0,
      pendingModelRequestTokenEstimate: 0,
    },
    validationCategoryCounts: {},
    recordTiming: () => undefined,
    send: async () => true,
  });
  audit = graphResult.audit;
  if (!graphResult.ok) {
    console.error(`graph validation failed: ${graphResult.validationError}`);
    process.exit(1);
  }

  const diagram = compileDiagramGraph({
    graph: graphResult.graph,
    username: "local",
    repo: basename(repo.rootPath),
    branch: repo.defaultBranch,
    pathTypes: repo.pathTypes,
  });

  const out = flags.get("out");
  if (out) {
    await writeFile(out, diagram, "utf8");
    console.error(`wrote ${out}`);
  } else {
    console.log(diagram);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
