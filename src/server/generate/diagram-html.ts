/**
 * Renders a compiled Mermaid diagram into one self-contained HTML file.
 *
 * No server, no build step: the file is opened directly from disk. Mermaid
 * itself is the only external load, from a CDN.
 */

export interface DiagramHtmlMeta {
  /** Repository name, used as the page title. */
  name: string;
  rootPath: string;
  /** Commit or branch the links point at, when there is one. */
  ref?: string | null;
  remoteUrl?: string | null;
  uncommittedChanges?: boolean;
  nodeCount: number;
  edgeCount: number;
  /** Files whose contents were actually read, in selection order. */
  readPaths: string[];
  /** Selected files that could not be read. */
  unavailableCount?: number;
  linksResolved: boolean;
  /** Nested repositories left out, named so the page does not overclaim. */
  nestedRepositories?: string[];
  generatedAt?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDiagramHtml(
  mermaid: string,
  meta: DiagramHtmlMeta,
): string {
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const refLabel = meta.ref ? meta.ref.slice(0, 12) : null;
  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  const facts: string[] = [
    plural(meta.nodeCount, "node"),
    plural(meta.edgeCount, "edge"),
    `${plural(meta.readPaths.length, "file")} read`,
  ];
  if (meta.unavailableCount) facts.push(`${meta.unavailableCount} unreadable`);
  if (refLabel) facts.push(`@ ${refLabel}`);

  // State the reading boundary on the page itself. A diagram is only as good
  // as the files behind it, and that list should travel with the picture.
  const caveats: string[] = [];
  if (meta.uncommittedChanges)
    caveats.push(
      "The working tree had uncommitted changes, so this reflects local state rather than the committed ref.",
    );
  if (!meta.linksResolved)
    caveats.push(
      "No recognized git remote, so node links were omitted rather than pointed at a URL that does not exist.",
    );
  if (meta.nestedRepositories?.length)
    caveats.push(
      `Nested repositories were excluded as separate projects: ${meta.nestedRepositories.join(", ")}.`,
    );
  caveats.push(
    "Edges were asserted from the files listed below. A missing edge may mean the caller was not among them.",
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.name)} architecture</title>
<style>
  :root {
    --bg: #ffffff;
    --panel: #f8fafc;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #2563eb;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b1120;
      --panel: #131c31;
      --border: #24304a;
      --text: #e6edf7;
      --muted: #93a4bd;
      --accent: #7aa2f7;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b1120;
    --panel: #131c31;
    --border: #24304a;
    --text: #e6edf7;
    --muted: #93a4bd;
    --accent: #7aa2f7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    padding: 20px 16px 16px;
    border-bottom: 1px solid var(--border);
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.01em; }
  .facts { color: var(--muted); font-size: 13px; }
  .facts span:not(:last-child)::after { content: " . "; }
  .path {
    margin-top: 8px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    color: var(--muted);
    word-break: break-all;
  }
  main { padding: 16px; }
  .stage {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    overflow: hidden;
    min-height: 60vh;
    cursor: grab;
  }
  .stage.dragging { cursor: grabbing; }
  .viewport { transform-origin: 0 0; padding: 24px; }
  .controls {
    position: absolute; top: 10px; right: 10px;
    display: flex; gap: 6px; z-index: 2;
  }
  button {
    font: inherit; font-size: 13px;
    padding: 5px 10px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  .hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
  details {
    margin-top: 18px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    padding: 12px 14px;
  }
  summary { cursor: pointer; font-weight: 600; font-size: 14px; }
  .files {
    margin: 10px 0 0; padding: 0; list-style: none;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12.5px;
    column-width: 320px;
  }
  .files li { padding: 1px 0; color: var(--muted); }
  .caveats { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
  .caveats li { margin-bottom: 4px; }
  footer {
    max-width: 1200px; margin: 0 auto;
    padding: 0 16px 28px;
    font-size: 12px; color: var(--muted);
  }
  @media (max-width: 640px) { .wrap, main { padding-left: 16px; padding-right: 16px; } }
</style>
</head>
<body>
<header><div class="wrap">
  <h1>${escapeHtml(meta.name)}</h1>
  <div class="facts">${facts.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</div>
  <div class="path">${escapeHtml(meta.rootPath)}</div>
</div></header>

<main><div class="wrap">
  <div class="stage" id="stage">
    <div class="controls">
      <button id="zoom-out" title="Zoom out">-</button>
      <button id="zoom-in" title="Zoom in">+</button>
      <button id="reset">Reset</button>
      <button id="theme">Theme</button>
    </div>
    <div class="viewport" id="viewport">
      <pre class="mermaid" id="graph">${escapeHtml(mermaid)}</pre>
    </div>
  </div>
  <div class="hint">Drag to pan, scroll to zoom${meta.linksResolved ? ", click a node to open its file" : ""}.</div>

  <details>
    <summary>Files read (${meta.readPaths.length})</summary>
    <ul class="files">${meta.readPaths.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
    <ul class="caveats">${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
  </details>
</div></main>

<footer>Generated ${escapeHtml(generatedAt)}${
    meta.remoteUrl ? ` from ${escapeHtml(meta.remoteUrl)}` : ""
  }</footer>

<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const dark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;

// securityLevel "loose" is what makes Mermaid's click directives navigate.
// The diagram source is produced locally by this project's own compiler.
async function draw() {
  const el = document.getElementById("graph");
  const source = el.dataset.source ?? el.textContent;
  el.dataset.source = source;
  el.removeAttribute("data-processed");
  el.textContent = source;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: dark() ? "dark" : "default",
  });
  await mermaid.run({ nodes: [el] });
}
await draw();

const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
let scale = 1, x = 0, y = 0, dragging = false, startX = 0, startY = 0;

function apply() {
  viewport.style.transform = \`translate(\${x}px, \${y}px) scale(\${scale})\`;
}
function zoom(factor) { scale = Math.min(6, Math.max(0.2, scale * factor)); apply(); }

stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

stage.addEventListener("pointerdown", (event) => {
  if (event.target.closest("a, button, .node")) return;
  dragging = true; startX = event.clientX - x; startY = event.clientY - y;
  stage.classList.add("dragging");
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  x = event.clientX - startX; y = event.clientY - startY; apply();
});
for (const type of ["pointerup", "pointercancel"])
  stage.addEventListener(type, () => { dragging = false; stage.classList.remove("dragging"); });

document.getElementById("zoom-in").onclick = () => zoom(1.25);
document.getElementById("zoom-out").onclick = () => zoom(1 / 1.25);
document.getElementById("reset").onclick = () => { scale = 1; x = 0; y = 0; apply(); };
document.getElementById("theme").onclick = async () => {
  document.documentElement.dataset.theme = dark() ? "light" : "dark";
  await draw();
};
</script>
</body>
</html>
`;
}
