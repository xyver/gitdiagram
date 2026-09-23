/**
 * Renders a compiled Mermaid diagram into one self-contained HTML file.
 *
 * No server, no build step: the file is opened directly from disk. Mermaid
 * itself is the only external load, from a CDN.
 *
 * The diagram is the page: it fills the viewport and everything else floats
 * over it, so a wide graph gets the whole screen instead of a letterbox.
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
    --panel: rgba(255, 255, 255, 0.92);
    --border: #d8e0ea;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #2563eb;
    --shadow: 0 6px 24px rgba(15, 23, 42, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b1120;
      --panel: rgba(19, 28, 49, 0.92);
      --border: #2b3a55;
      --text: #e6edf7;
      --muted: #93a4bd;
      --accent: #7aa2f7;
      --shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b1120;
    --panel: rgba(19, 28, 49, 0.92);
    --border: #2b3a55;
    --text: #e6edf7;
    --muted: #93a4bd;
    --accent: #7aa2f7;
    --shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    overflow: hidden;
  }

  /* The diagram is the page background. */
  #stage {
    position: fixed;
    inset: 0;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
  }
  #stage.dragging { cursor: grabbing; }
  #viewport { transform-origin: 0 0; will-change: transform; }
  #viewport svg { display: block; }

  .panel {
    position: fixed;
    z-index: 5;
    background: var(--panel);
    backdrop-filter: blur(8px);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
  }
  #info { top: 14px; left: 14px; padding: 12px 16px; max-width: min(46vw, 560px); }
  #info h1 { margin: 0 0 4px; font-size: 17px; letter-spacing: -0.01em; }
  .facts { color: var(--muted); font-size: 12.5px; }
  .facts span:not(:last-child)::after { content: " \\00B7 "; }
  .path {
    margin-top: 6px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11.5px;
    color: var(--muted);
    word-break: break-all;
  }

  #controls { top: 14px; right: 14px; padding: 8px; display: flex; gap: 6px; }
  button {
    font: inherit; font-size: 13px;
    padding: 5px 11px;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }

  #files {
    bottom: 14px; left: 14px;
    padding: 10px 14px;
    max-width: min(46vw, 560px);
    max-height: 46vh;
    overflow: auto;
  }
  #files summary { cursor: pointer; font-weight: 600; font-size: 13.5px; }
  .list {
    margin: 10px 0 0; padding: 0; list-style: none;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    column-width: 240px;
  }
  .list li { padding: 1px 0; color: var(--muted); }
  .caveats { margin: 10px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted); }
  .caveats li { margin-bottom: 4px; }
  .generated { margin-top: 10px; font-size: 11.5px; color: var(--muted); }

  #hint {
    bottom: 16px; right: 16px;
    padding: 6px 12px;
    font-size: 12px; color: var(--muted);
  }
  @media (max-width: 760px) {
    #info, #files { max-width: calc(100vw - 28px); }
    #hint { display: none; }
  }
</style>
</head>
<body>

<div id="stage">
  <div id="viewport">
    <pre class="mermaid" id="graph">${escapeHtml(mermaid)}</pre>
  </div>
</div>

<div class="panel" id="info">
  <h1>${escapeHtml(meta.name)}</h1>
  <div class="facts">${facts.map((f) => `<span>${escapeHtml(f)}</span>`).join("")}</div>
  <div class="path">${escapeHtml(meta.rootPath)}</div>
</div>

<div class="panel" id="controls">
  <button id="zoom-out" title="Zoom out">-</button>
  <button id="zoom-in" title="Zoom in">+</button>
  <button id="reset" title="Fit to screen">Fit</button>
  <button id="theme" title="Toggle theme">Theme</button>
</div>

<details class="panel" id="files">
  <summary>Files read (${meta.readPaths.length})</summary>
  <ul class="list">${meta.readPaths.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
  <ul class="caveats">${caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
  <div class="generated">Generated ${escapeHtml(generatedAt)}${
    meta.remoteUrl ? ` from ${escapeHtml(meta.remoteUrl)}` : ""
  }</div>
</details>

<div class="panel" id="hint">Drag to pan &middot; scroll to zoom${
    meta.linksResolved ? " &middot; click a node to open its file" : ""
  }</div>

<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
let scale = 1, x = 0, y = 0;

const dark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;

function apply() {
  viewport.style.transform =
    "translate(" + x + "px," + y + "px) scale(" + scale + ")";
}

// securityLevel "loose" is what makes Mermaid's click directives navigate.
// The diagram source is produced locally by this project's own compiler.
async function draw() {
  const el = document.getElementById("graph");
  const source = el.dataset.source || el.textContent;
  el.dataset.source = source;
  el.removeAttribute("data-processed");
  el.textContent = source;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: dark() ? "dark" : "default",
    flowchart: { useMaxWidth: false },
  });
  await mermaid.run({ nodes: [el] });
}

// Mermaid sizes its SVG to the container through a viewBox, so pin the element
// to the viewBox's intrinsic size before measuring - otherwise the fit scale
// compounds with Mermaid's own scaling and the diagram shrinks.
function fit() {
  const svg = viewport.querySelector("svg");
  if (!svg || !svg.viewBox || !svg.viewBox.baseVal.width) return;
  const natural = svg.viewBox.baseVal;
  svg.style.maxWidth = "none";
  svg.setAttribute("width", natural.width);
  svg.setAttribute("height", natural.height);
  const pad = 48;
  scale = Math.min(
    (window.innerWidth - pad) / natural.width,
    (window.innerHeight - pad) / natural.height,
    2,
  );
  x = (window.innerWidth - natural.width * scale) / 2;
  y = (window.innerHeight - natural.height * scale) / 2;
  apply();
}

function zoomAt(factor, clientX, clientY) {
  const next = Math.min(8, Math.max(0.05, scale * factor));
  // Keep the point under the cursor fixed while zooming.
  x = clientX - ((clientX - x) * next) / scale;
  y = clientY - ((clientY - y) * next) / scale;
  scale = next;
  apply();
}

stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  },
  { passive: false },
);

// Drag from anywhere, including on top of a node: Mermaid renders node labels
// as <p> inside foreignObject, so guarding on the event target would block
// almost every drag. A node click is instead distinguished by how far the
// pointer travelled.
let dragging = false, moved = 0, startX = 0, startY = 0;

stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  dragging = true;
  moved = 0;
  startX = event.clientX - x;
  startY = event.clientY - y;
  stage.classList.add("dragging");
  stage.setPointerCapture(event.pointerId);
});

stage.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const nextX = event.clientX - startX;
  const nextY = event.clientY - startY;
  moved += Math.abs(nextX - x) + Math.abs(nextY - y);
  x = nextX;
  y = nextY;
  apply();
});

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  stage.classList.remove("dragging");
  if (stage.hasPointerCapture(event.pointerId))
    stage.releasePointerCapture(event.pointerId);
}
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);

// Suppress the node's click handler when the gesture was a pan, not a click.
stage.addEventListener(
  "click",
  (event) => {
    if (moved > 5) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);

document.getElementById("zoom-in").onclick = () =>
  zoomAt(1.25, window.innerWidth / 2, window.innerHeight / 2);
document.getElementById("zoom-out").onclick = () =>
  zoomAt(1 / 1.25, window.innerWidth / 2, window.innerHeight / 2);
document.getElementById("reset").onclick = fit;
document.getElementById("theme").onclick = async () => {
  document.documentElement.dataset.theme = dark() ? "light" : "dark";
  await draw();
  fit();
};

await draw();
fit();
window.addEventListener("resize", fit);
</script>
</body>
</html>
`;
}
