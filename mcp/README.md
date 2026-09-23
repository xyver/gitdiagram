# Repo Diagram MCP

A local stdio MCP server that turns a directory on disk into an architecture
diagram. It is a fork of gitdiagram's generation modules with the hosted service
removed.

## Interaction boundary

There is no server-side LLM. The server does deterministic work only: it walks
the repository, ranks and excerpts source files, validates a graph the client
proposes against the real file tree, and compiles Mermaid. The calling client
model reads the excerpts and proposes the graph, and pays for all of that
reasoning.

This removes the original design's dependency on the OpenAI Responses API.
Upstream gitdiagram calls `client.responses.stream` and `client.responses.parse`
from a server-side key. Nothing here calls a model, so no key, no provider, and
no per-run cost.

Nothing in this server reaches the network.

## Tools

Discovery-first. Nine tools.

- `how_repo_diagram_works` - the model, the workflow, the honesty rules
- `get_tool_help` - one tool's use/refusal guidance, example, outputs, next calls
- `set_repo_root` - point the server at a local directory
- `read_repo_structure` - file tree, path counts, candidate source inventory
- `read_repo_sources` - **binds** a file selection and returns ranked excerpts
- `get_graph_contract` - the exact graph schema, id rules and caps
- `validate_repo_graph` - check a proposed graph against the bound tree
- `compile_repo_diagram` - render a validated graph to Mermaid
- `render_diagram_html` - write a browsable HTML file

`read_repo_sources` is the binding step, and `validate_repo_graph` enforces its
file tree: a node whose `path` is not in the repository is refused with
`graph_invalid` and typed repair feedback. The client fixes the graph itself
rather than asking the user. This is the honesty gate - a diagram that cites a
file that does not exist is wrong the same way a fabricated citation is wrong.

Errors carry `error.code`, `guidance` and `clarification.required`. Ask the user
only when `clarification.required` is true; otherwise repair the call directly.

## Seeing the diagram

Mermaid source is not a diagram until something renders it, so
`render_diagram_html` writes one self-contained HTML file you open directly from
disk. No server, no build step - the only external load is Mermaid from a CDN.

The page has pan and zoom, a light/dark toggle, clickable nodes when links
resolved, and a collapsible list of exactly which files the diagram was built
from. That list travels with the picture on purpose: a diagram is only as good
as the files behind it, and a missing edge usually means the caller was not
among them.

Output lands in this project's `output/` folder as
`<name>_<YYYY-MM-DD_HHMMSS>.html`, which is gitignored. Runs accumulate rather
than overwriting, and nothing is ever written into the repository being
analyzed. Pass `out_path` to put it somewhere specific.

The CLI has the same output:

```powershell
bun run scripts/local-diagram.ts <repo-path> --html
```

`--html` with no path uses the same default; give it a path to override.

## Depth

Upstream ships conservative defaults sized for a shared hosted budget: 12 files
and 48,000 characters per run. Those are now call-time settings.

Per call, via `read_repo_sources`: `max_files`, `max_characters`,
`max_file_characters`, `directory_diversity_penalty`, or an explicit `paths`
list.

Or as environment defaults: `GD_MAX_SOURCE_FILES`, `GD_MAX_SOURCE_CHARACTERS`,
`GD_MAX_SOURCE_FILE_CHARACTERS`, `GD_DIRECTORY_DIVERSITY_PENALTY`,
`GD_MAX_TREE_CHARACTERS`, `GD_MAX_README_CHARACTERS`.

`directory_diversity_penalty` is the ranking penalty applied per file already
taken from the same directory. The default of 5 spreads the selection across
subsystems, which is right for a 12-file budget and wrong for a large one. Lower
it to go deep into one area.

The graph caps are fixed at 10 groups, 34 nodes and 48 edges. Reading more files
therefore buys **edge accuracy**, not a bigger diagram. That is the failure mode
worth fixing: a shallow read produces correct node names with missing
connections between them.

## Pointing it at a repository

You give it a local filesystem path, not a URL. If that directory happens to be
a git clone, the server reads its origin remote, branch and checked-out commit,
and compiles node links against those real coordinates - so a clone of a GitHub
repo produces genuine blob URLs pinned to the exact commit that was read.

- **GitHub clone:** real `github.com/<owner>/<repo>/blob/<commit>/...` links
- **GitLab clone:** real GitLab blob links
- **Any other remote, or no git at all:** links are omitted rather than
  fabricated. Pass `link_base_url` to `compile_repo_diagram` to set your own.

`set_repo_root` reports what it found under `git`, including
`uncommitted_changes`. The server always reads the working tree on disk, so a
dirty checkout is analyzed as it currently is while links point at the committed
ref. That difference is stated in the compile result rather than hidden.

This also means a private repo works with no token: the files are already on
disk, and nothing is uploaded.

## Isolation and setup

The folder is self-contained. `bun` is a dev dependency of this project, so
`node_modules/.bin/bun.exe` is the only runtime needed and nothing is installed
globally or added to PATH.

```powershell
bun install    # or: node_modules\.bin\bun.exe install
```

`mcp/run.cmd` launches the server with that vendored bun, which is what makes
registration work without a global install:

```powershell
claude.cmd mcp add repo-diagram -- C:\Users\<you>\Desktop\gitdiagram\mcp\run.cmd
```

An optional directory argument after the launcher sets the initial repo root so
a client can skip `set_repo_root`.

Other MCP clients: register a stdio server with that same command.

## Run the smoke test

Offline, no model, no network:

```powershell
bun run mcp/smoke-test.ts <path-to-any-repo>
```

It runs the documented workflow end to end and asserts that an invented file
path is refused while a real one validates and compiles. Unit tests for the
local reader and remote parsing:

```powershell
bun x vitest run src/server/generate/local-repo.test.ts
```

## Relationship to upstream

Changes to gitdiagram's own modules are additive and keep hosted defaults:

- `src/server/generate/local-repo.ts` - new; builds the repository struct from
  disk via `git ls-files`, falling back to a directory walk, and reads the
  clone's origin/branch/commit for link resolution
- `src/server/generate/repository-context.ts` - depth limits read at call time
  instead of import time
- `src/server/generate/source-context.ts` - excerpt budgeting extracted into
  `assembleSourceContext`, shared by the GitHub and local readers
- `src/server/generate/openai.ts` - `OPENAI_BASE_URL` passthrough (unused by
  this server; kept for `scripts/local-diagram.ts`)
- `package.json` - the `ajv` override moved from 6.15.0 to 8.20.0, because
  `ajv-formats@3` under the MCP SDK requires ajv 8. This is the one change that
  touches an upstream pin.

`scripts/local-diagram.ts` is the other entry point: the same local reading, but
driving a real API model end to end instead of an MCP client. It needs a key.
