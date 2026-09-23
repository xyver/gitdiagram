/**
 * Repo Diagram MCP - a local, stdio MCP server that turns a directory on disk
 * into an architecture diagram.
 *
 * There is no server-side LLM. This server does deterministic work only:
 * it walks the repository, ranks and excerpts source files, validates a graph
 * the client proposes against the real file tree, and compiles Mermaid. The
 * calling client model does all the reasoning and pays for all of it.
 *
 * Nothing here reaches the network.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  readLocalRepository,
  readLocalSourceContext,
  type LocalGitOrigin,
} from "../src/server/generate/local-repo";
import {
  prepareRepositoryContext,
  isArchitectureSource,
  maxSourceCharacters,
  maxSourceFiles,
} from "../src/server/generate/repository-context";
import {
  buildFileTreeLookup,
  compileDiagramGraph,
  formatGraphValidationFeedback,
  normalizeKnownGraphPaths,
  validateDiagramGraph,
} from "../src/server/generate/graph";
import { diagramGraphSchema } from "../src/features/diagram/graph";
import { validateMermaidSyntax } from "../src/server/generate/mermaid";
import { renderDiagramHtml } from "../src/server/generate/diagram-html";
import type { GithubData } from "../src/server/generate/github";

const SERVER_NAME = "repo-diagram";
const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Local repo-diagram MCP. This server does deterministic repository reading,",
  "graph validation and Mermaid compilation; it does not run a hidden diagram",
  "LLM. You are the model that reads the source and proposes the graph.",
  "If the user asks how this MCP works, call how_repo_diagram_works. Use",
  "get_tool_help with an exact name from tools/list for one tool's contract.",
  "Workflow: set_repo_root, then read_repo_structure to see the tree, then",
  "read_repo_sources to bind a file selection and receive excerpts. Read those",
  "excerpts and propose a graph. Call get_graph_contract for the exact schema",
  "and caps before you write one. validate_repo_graph is the honesty gate: it",
  "refuses any node whose path is not in the bound selection's file tree, so",
  "do not invent files. On a validation error, read issues and feedback and",
  "repair the graph yourself rather than asking the user. Then",
  "compile_repo_diagram, or render_diagram_html when the user wants something",
  "to look at rather than Mermaid source. Assert an edge only when you saw the",
  "caller in an excerpt; an absent edge is better than a guessed one, and",
  "missing source is never proof that no edge exists.",
].join(" ");

interface BoundSelection {
  rootPath: string;
  repo: GithubData & {
    rootPath: string;
    origin: LocalGitOrigin;
    nestedRepositories: string[];
  };
  fileTree: string;
  fileTreeLookup: Set<string>;
  selectedPaths: string[];
  readPaths: string[];
}

let activeRootPath: string | null = null;
let bound: BoundSelection | null = null;

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function fail(
  code: string,
  guidance: string,
  clarificationRequired = false,
  extra: Record<string, unknown> = {},
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: { code },
            guidance,
            clarification: { required: clarificationRequired },
            ...extra,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const HOW_IT_WORKS = {
  model:
    "Deterministic server, reasoning client. The server reads the repository " +
    "and validates what you propose. It never calls a language model.",
  workflow: [
    "set_repo_root - point the server at a directory on disk",
    "read_repo_structure - file tree, counts, candidate source inventory",
    "read_repo_sources - bind a selection and get ranked source excerpts",
    "get_graph_contract - the exact graph schema, caps and id rules",
    "validate_repo_graph - check your proposed graph against the real tree",
    "compile_repo_diagram - render validated graph to Mermaid",
    "render_diagram_html - write a browsable HTML file the user can open",
  ],
  honesty_rules: [
    "Every node path must exist in the bound file tree. Invented paths are refused.",
    "Assert an edge only when an excerpt showed the caller.",
    "Absent source is not proof that no edge exists; say what you did not read.",
    "Excerpts may be partial. Partial excerpts are marked in the returned text.",
  ],
  depth: {
    files_per_run: maxSourceFiles(),
    prompt_characters: maxSourceCharacters(),
    note:
      "Depth is set by GD_MAX_SOURCE_FILES, GD_MAX_SOURCE_CHARACTERS, " +
      "GD_MAX_SOURCE_FILE_CHARACTERS and GD_DIRECTORY_DIVERSITY_PENALTY, or " +
      "per call via read_repo_sources. Graph caps are fixed, so extra depth " +
      "buys edge accuracy rather than a larger diagram.",
  },
};

const TOOL_HELP: Record<string, unknown> = {
  set_repo_root: {
    use: "Point the server at a local directory before anything else.",
    refuse: "A path that is not a directory.",
    example: { root_path: "C:/Users/you/Desktop/my-project" },
    outputs: "Resolved root, whether it is a git repo, tracked file count.",
    next: ["read_repo_structure"],
  },
  read_repo_structure: {
    use: "See the tree and how many files are diagram candidates, before binding a selection.",
    refuse: "No active root.",
    example: { max_paths: 400 },
    outputs: "Tree excerpt, total paths, candidate source count, README presence.",
    next: ["read_repo_sources"],
  },
  read_repo_sources: {
    use: "Bind a file selection and receive ranked excerpts. This is the binding step; validate_repo_graph enforces its tree.",
    refuse: "No active root. A requested path outside the repository.",
    example: { max_files: 40, directory_diversity_penalty: 1 },
    outputs: "Selected paths, excerpt text with FILE markers, budget usage.",
    next: ["get_graph_contract", "validate_repo_graph"],
  },
  get_graph_contract: {
    use: "Get the exact graph schema, id rules and caps before writing a graph.",
    refuse: "Never refuses.",
    example: {},
    outputs: "JSON schema, caps, id patterns, shape and style enums.",
    next: ["validate_repo_graph"],
  },
  validate_repo_graph: {
    use: "Check a proposed graph against the bound file tree and the schema.",
    refuse: "No bound selection. Node paths absent from the tree.",
    example: {
      graph: {
        groups: [{ id: "api", label: "API layer", description: null }],
        nodes: [
          {
            id: "routes",
            label: "HTTP routes",
            type: "component",
            description: null,
            groupId: "api",
            path: "src/routes.ts",
            shape: "box",
          },
        ],
        edges: [],
      },
    },
    outputs: "ok flag, typed issues, repair feedback, normalized graph.",
    next: ["compile_repo_diagram"],
  },
  compile_repo_diagram: {
    use: "Render a validated graph to Mermaid flowchart source.",
    refuse: "A graph that does not validate.",
    example: { graph: "<a graph that passed validate_repo_graph>" },
    outputs: "Mermaid source, node and edge counts, syntax check result.",
    next: ["render_diagram_html"],
  },
  render_diagram_html: {
    use: "Give the user something to look at: a self-contained HTML file with pan, zoom, clickable nodes and the list of files behind the diagram.",
    refuse: "A graph that does not validate.",
    example: { graph: "<validated graph>", out_path: "C:/tmp/architecture.html" },
    outputs: "Path of the written file. Opens directly in a browser, no server.",
    next: [],
  },
  how_repo_diagram_works: {
    use: "Explain the model and workflow to the user.",
    refuse: "Never refuses.",
    example: { question: "how do you work?" },
    outputs: "Model, workflow, honesty rules, depth settings.",
    next: ["set_repo_root"],
  },
};

function toolDefinitions() {
  return [
    {
      name: "how_repo_diagram_works",
      title: "How Repo Diagram MCP Works",
      description:
        "Explain the deterministic-server / reasoning-client model, the tool workflow, and the honesty rules for asserting edges.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Optional user wording, such as 'how do you work?'.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_tool_help",
      title: "Get Tool Help",
      description:
        "Return use/refusal guidance, an example, outputs and likely next calls for one exact tool name from tools/list.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: { type: "string", description: "Exact tool name." },
        },
        required: ["tool_name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "set_repo_root",
      title: "Set Repo Root",
      description:
        "Point this server at a local directory to analyze. Local paths only; nothing is uploaded and no network call is made.",
      inputSchema: {
        type: "object",
        properties: {
          root_path: {
            type: "string",
            description: "Absolute path to the repository directory on disk.",
          },
        },
        required: ["root_path"],
        additionalProperties: false,
      },
    },
    {
      name: "read_repo_structure",
      title: "Read Repo Structure",
      description:
        "Return the repository file tree, total path count, diagram-candidate source count and README presence for the active root.",
      inputSchema: {
        type: "object",
        properties: {
          max_paths: {
            type: "integer",
            minimum: 1,
            description: "Cap on returned tree lines. Default 500.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "read_repo_sources",
      title: "Read Repo Sources",
      description:
        "Bind a file selection and return ranked source excerpts. Binding is required before validate_repo_graph, which enforces this selection's file tree.",
      inputSchema: {
        type: "object",
        properties: {
          max_files: {
            type: "integer",
            minimum: 1,
            maximum: 400,
            description: "Files to read this run. Higher values improve edge accuracy.",
          },
          max_characters: {
            type: "integer",
            minimum: 1000,
            description: "Total excerpt budget in characters.",
          },
          max_file_characters: {
            type: "integer",
            minimum: 500,
            description: "Per-file excerpt ceiling.",
          },
          directory_diversity_penalty: {
            type: "integer",
            minimum: 0,
            description:
              "Ranking penalty per file already taken from the same directory. Lower goes deeper into one subsystem; higher spreads across the repo.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Explicit repo-relative paths to read instead of the ranked selection.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_graph_contract",
      title: "Get Graph Contract",
      description:
        "Return the exact graph JSON schema, id patterns, node shapes, edge styles and the fixed caps on groups, nodes and edges.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "validate_repo_graph",
      title: "Validate Repo Graph",
      description:
        "Validate a proposed graph against the schema and the bound repository tree. Returns typed issues and repair feedback. Node paths absent from the tree are refused.",
      inputSchema: {
        type: "object",
        properties: {
          graph: {
            type: "object",
            description: "Proposed graph: { groups, nodes, edges }.",
          },
          strip_unknown_paths: {
            type: "boolean",
            description:
              "Drop unresolvable node paths instead of failing. Default false; prefer fixing the paths.",
          },
        },
        required: ["graph"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "render_diagram_html",
      title: "Render Diagram To HTML",
      description:
        "Write a validated graph to a self-contained HTML file that opens directly in a browser, with pan, zoom and the list of files the diagram was based on. Returns the file path.",
      inputSchema: {
        type: "object",
        properties: {
          graph: { type: "object", description: "A graph that passed validation." },
          out_path: {
            type: "string",
            description:
              "Where to write the file. Defaults to <repo>/architecture.html.",
          },
          link_base_url: {
            type: "string",
            description: "Optional base URL for node click links.",
          },
        },
        required: ["graph"],
        additionalProperties: false,
      },
    },
    {
      name: "compile_repo_diagram",
      title: "Compile Repo Diagram",
      description:
        "Compile a validated graph into Mermaid flowchart source with clickable file links, and syntax-check the result.",
      inputSchema: {
        type: "object",
        properties: {
          graph: { type: "object", description: "A graph that passed validation." },
          link_base_url: {
            type: "string",
            description:
              "Optional base URL for node click links. Omit for local paths only.",
          },
        },
        required: ["graph"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

const CLICK_LINE =
  /^click (\S+) "https:\/\/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/[^/]+\/(.*)"$/;

/**
 * Blob URL prefix for a recognized forge. Includes the analyzed directory's
 * position inside its repository: node paths are relative to that directory,
 * but forge URLs are rooted at the repo, so a subdirectory needs its prefix
 * added back or every link 404s.
 */
function forgeBaseUrl(origin: LocalGitOrigin): string {
  if (!origin.host || !origin.owner || !origin.name) return "";
  const ref = origin.commit ?? origin.branch;
  const root =
    origin.host === "gitlab"
      ? `https://gitlab.com/${origin.owner}/${origin.name}/-/blob/${ref}`
      : `https://github.com/${origin.owner}/${origin.name}/blob/${ref}`;
  return `${root}/${origin.pathPrefix}`.replace(/\/+$/, "");
}

/**
 * Point the compiler's placeholder links at a real base URL, or drop them.
 * Without a recognized remote there is nowhere real to link to, and a URL that
 * does not exist is worse than no link at all.
 */
function rewriteClickLinks(diagram: string, base: string): string {
  const lines = diagram.split("\n").map((line) => {
    const match = CLICK_LINE.exec(line.trim());
    if (!match) return line;
    if (!base) return null;
    return `click ${match[1]} "${base.replace(/\/$/, "")}/${match[2]}"`;
  });
  return lines.filter((line): line is string => line !== null).join("\n");
}

/**
 * Shared by compile_repo_diagram and render_diagram_html: validate the graph
 * against the bound tree, compile it, and resolve node links honestly.
 */
type BuildResult =
  | { ok: false; response: ReturnType<typeof fail> }
  | {
      ok: true;
      diagram: string;
      normalized: ReturnType<typeof normalizeKnownGraphPaths>;
      origin: LocalGitOrigin;
      linksAreReal: boolean;
    };

function buildDiagram(args: Record<string, unknown>): BuildResult {
  if (!bound)
    return {
      ok: false,
      response: fail("no_bound_selection", "Call read_repo_sources first.", true),
    };
  const parsed = diagramGraphSchema.safeParse(args.graph);
  if (!parsed.success)
    return {
      ok: false,
      response: fail(
        "schema_invalid",
        "Graph does not match the contract. Validate it first.",
        false,
        { issues: parsed.error.issues.slice(0, 20) },
      ),
    };
  const normalized = normalizeKnownGraphPaths(parsed.data, bound.fileTreeLookup);
  const check = validateDiagramGraph(normalized, bound.fileTreeLookup);
  if (!check.valid)
    return {
      ok: false,
      response: fail(
        "graph_invalid",
        formatGraphValidationFeedback(check.issues),
        false,
        { issues: check.issues },
      ),
    };

  const origin = bound.repo.origin;
  // Compile with placeholder coordinates, then retarget every link once. That
  // keeps one code path for repo roots, subdirectories, GitLab and no remote.
  const compiled = compileDiagramGraph({
    graph: normalized,
    username: "local",
    repo: basename(bound.rootPath),
    branch: origin.commit ?? origin.branch,
    pathTypes: bound.repo.pathTypes,
  });
  const explicitBase =
    typeof args.link_base_url === "string" ? args.link_base_url.trim() : "";
  const linkBase = explicitBase || forgeBaseUrl(origin);
  return {
    ok: true,
    diagram: rewriteClickLinks(compiled, linkBase),
    normalized,
    origin,
    linksAreReal: Boolean(linkBase),
  };
}

function applyDepthOverrides(args: Record<string, unknown>) {
  const set = (envName: string, value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value))
      process.env[envName] = String(Math.trunc(value));
  };
  set("GD_MAX_SOURCE_FILES", args.max_files);
  set("GD_MAX_SOURCE_CHARACTERS", args.max_characters);
  set("GD_MAX_SOURCE_FILE_CHARACTERS", args.max_file_characters);
  set("GD_DIRECTORY_DIVERSITY_PENALTY", args.directory_diversity_penalty);
}

async function handleTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case "how_repo_diagram_works":
      return ok(HOW_IT_WORKS);

    case "get_tool_help": {
      const toolName = String(args.tool_name ?? "");
      const help = TOOL_HELP[toolName];
      if (!help)
        return fail(
          "unknown_tool",
          `No tool named ${JSON.stringify(toolName)}. Call tools/list for exact names.`,
        );
      return ok({ tool_name: toolName, ...(help as object) });
    }

    case "set_repo_root": {
      const rootPath = String(args.root_path ?? "");
      if (!rootPath)
        return fail("missing_root_path", "Provide root_path, an absolute directory path.");
      try {
        const repo = await readLocalRepository(rootPath);
        activeRootPath = repo.rootPath;
        bound = null;
        return ok({
          root_path: repo.rootPath,
          name: repo.origin.name ?? basename(repo.rootPath),
          total_paths: repo.pathTypes.size,
          candidate_sources: repo.sourceBlobs?.size ?? 0,
          has_readme: repo.readme.length > 0,
          git: {
            is_clone: Boolean(repo.origin.commit),
            remote_url: repo.origin.remoteUrl,
            host: repo.origin.host,
            owner: repo.origin.owner,
            branch: repo.origin.branch,
            commit: repo.origin.commit,
            uncommitted_changes: repo.origin.dirty,
            path_prefix: repo.origin.pathPrefix,
          },
          nested_repositories_excluded: repo.nestedRepositories,
          reading:
            "the working tree on disk, not the remote" +
            (repo.nestedRepositories.length
              ? ` - nested repositories (${repo.nestedRepositories.join(", ")}) are separate projects and were excluded; point the tool at one directly to diagram it`
              : "") +
            (repo.origin.dirty
              ? " - it has uncommitted changes, so it differs from the pushed commit"
              : ""),
          next: "read_repo_structure",
        });
      } catch (error) {
        return fail(
          "unreadable_root",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    }

    case "read_repo_structure": {
      if (!activeRootPath)
        return fail("no_active_root", "Call set_repo_root first.", true);
      const repo = await readLocalRepository(activeRootPath);
      const context = prepareRepositoryContext(repo);
      const maxPaths =
        typeof args.max_paths === "number" ? Math.trunc(args.max_paths) : 500;
      const lines = context.fileTree.split("\n");
      return ok({
        root_path: repo.rootPath,
        total_paths: repo.pathTypes.size,
        candidate_sources: repo.sourceBlobs?.size ?? 0,
        tree_truncated: context.treeTruncated || lines.length > maxPaths,
        file_tree: lines.slice(0, maxPaths).join("\n"),
        readme_characters: context.readme.length,
        ranked_preview: context.selectedPaths,
        next: "read_repo_sources",
      });
    }

    case "read_repo_sources": {
      if (!activeRootPath)
        return fail("no_active_root", "Call set_repo_root first.", true);
      applyDepthOverrides(args);
      const repo = await readLocalRepository(activeRootPath);
      const context = prepareRepositoryContext(repo);

      let selectedPaths = context.selectedPaths;
      if (Array.isArray(args.paths) && args.paths.length) {
        const requested = args.paths.map(String);
        const unknown = requested.filter((p) => !repo.pathTypes.has(p));
        if (unknown.length)
          return fail(
            "unknown_path",
            "These paths are not in the repository. Use read_repo_structure to see real paths.",
            false,
            { unknown_paths: unknown },
          );
        const notSource = requested.filter((p) => !isArchitectureSource(p));
        if (notSource.length)
          return fail(
            "not_architecture_source",
            "These paths are excluded from architecture analysis (tests, docs, assets, build output).",
            false,
            { excluded_paths: notSource },
          );
        selectedPaths = requested;
      }

      const sources = await readLocalSourceContext({
        rootPath: repo.rootPath,
        selectedPaths,
      });
      bound = {
        rootPath: repo.rootPath,
        repo,
        fileTree: context.fileTree,
        fileTreeLookup: buildFileTreeLookup(repo.fileTree),
        selectedPaths,
        readPaths: sources.paths,
      };
      return ok({
        bound: true,
        read_paths: sources.paths,
        unavailable_count: sources.unavailableCount,
        characters_used: sources.text.length,
        character_budget: maxSourceCharacters(),
        file_budget: maxSourceFiles(),
        reminder:
          "Assert an edge only where an excerpt shows the caller. Partial excerpts are marked.",
        source_excerpts: sources.text,
      });
    }

    case "get_graph_contract":
      return ok({
        schema: {
          groups: "array, max 10, of { id, label, description|null }",
          nodes:
            "array, min 1 max 34, of { id, label, type, description|null, groupId|null, path|null, shape|null }",
          edges:
            "array, max 48, of { from, to, label|null, description|null, style|null }",
        },
        id_pattern: "^[a-z][a-z0-9_]*$ for group ids, node ids, edge from/to",
        node_shapes: ["box", "database", "queue", "document", "circle", "hexagon"],
        edge_styles: ["solid", "dashed"],
        limits: {
          label_characters: 72,
          type_characters: 72,
          description_characters: 240,
          path_characters: 512,
        },
        rules: [
          "path must be a real repo-relative file path from the bound selection, or null",
          "groupId must reference a declared group id, or null",
          "edge from/to must reference declared node ids",
          "Caps are fixed. Reading more files improves edge accuracy, not node count.",
        ],
      });

    case "validate_repo_graph": {
      if (!bound)
        return fail(
          "no_bound_selection",
          "Call read_repo_sources first; validation enforces its file tree.",
          true,
        );
      const parsed = diagramGraphSchema.safeParse(args.graph);
      if (!parsed.success)
        return fail(
          "schema_invalid",
          "Graph does not match the contract. Call get_graph_contract and correct it.",
          false,
          { issues: parsed.error.issues.slice(0, 20) },
        );
      const normalized = normalizeKnownGraphPaths(
        parsed.data,
        bound.fileTreeLookup,
      );
      const result = validateDiagramGraph(normalized, bound.fileTreeLookup);
      if (!result.valid)
        return fail(
          "graph_invalid",
          formatGraphValidationFeedback(result.issues),
          false,
          { issues: result.issues },
        );
      return ok({
        ok: true,
        graph: normalized,
        node_count: normalized.nodes.length,
        edge_count: normalized.edges.length,
        next: "compile_repo_diagram",
      });
    }

    case "compile_repo_diagram":
    case "render_diagram_html": {
      const built = buildDiagram(args);
      if (!built.ok) return built.response;
      const { diagram, normalized, origin, linksAreReal } = built;

      if (name === "render_diagram_html") {
        const outPath =
          typeof args.out_path === "string" && args.out_path.trim()
            ? resolve(args.out_path.trim())
            : join(bound!.rootPath, "architecture.html");
        const html = renderDiagramHtml(diagram, {
          name: origin.name ?? basename(bound!.rootPath),
          rootPath: bound!.rootPath,
          ref: origin.commit ?? origin.branch,
          remoteUrl: origin.remoteUrl,
          uncommittedChanges: origin.dirty,
          nodeCount: normalized.nodes.length,
          edgeCount: normalized.edges.length,
          readPaths: bound!.readPaths,
          linksResolved: linksAreReal,
          nestedRepositories: bound!.repo.nestedRepositories,
        });
        await writeFile(outPath, html, "utf8");
        return ok({
          html_path: outPath,
          node_count: normalized.nodes.length,
          edge_count: normalized.edges.length,
          open_with: "Open this file directly in a browser. No server needed.",
        });
      }

      const syntax = await validateMermaidSyntax(diagram).catch(
        (error: unknown) => ({
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return ok({
        mermaid: diagram,
        node_count: normalized.nodes.length,
        edge_count: normalized.edges.length,
        syntax_check: syntax,
        read_paths: bound!.readPaths,
        links: linksAreReal
          ? {
              resolved: true,
              pinned_to: origin.commit ?? origin.branch,
              note: origin.dirty
                ? "Links point at the committed ref; the working tree read here has uncommitted changes."
                : "Links point at the exact commit that was read.",
            }
          : {
              resolved: false,
              note:
                "No recognized remote, so node links were omitted rather than " +
                "pointing at a URL that does not exist. Pass link_base_url to set one.",
            },
      });
    }

    default:
      return fail("unknown_tool", `No tool named ${JSON.stringify(name)}.`);
  }
}

async function main() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await handleTool(request.params.name, args);
    } catch (error) {
      return fail(
        "tool_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  // An initial root can be supplied at launch so a client can skip set_repo_root.
  const initialRoot = process.argv[2];
  if (initialRoot) activeRootPath = resolve(initialRoot);

  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
