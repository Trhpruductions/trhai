// Showing a rendering, the way Jarvis would.
//
// build_app writes a running application; make_video renders a clip. This is
// the lighter thing in between: "show me a mockup of a login screen", "render
// a diagram of how the build pipeline works" — a single self-contained visual,
// authored by the local model and thrown straight onto the HUD as a live
// panel. No app to run, no npm, no video encode; just one HTML document.
//
// It stays inside every standing rule: the local model writes it (no API key),
// and the document must be fully self-contained (no fonts, scripts, images or
// styles fetched from the internet) so it renders identically offline and on
// whatever machine this app is later moved to.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./workspace.js";

export type RenderKind = "mockup" | "diagram";

export type Rendering = { name: string; title: string; kind: RenderKind; createdAt: string };
export type RenderingWithHtml = Rendering & { html: string };

/** Where renderings live, under the (configurable) workspace so they move with it. */
export function renderingsDir(): string {
  return path.join(path.resolve(workspaceRoot()), "renderings");
}

/**
 * Which kind of visual the request wants, when the caller did not say.
 *
 * A diagram/flowchart/blueprint is drawn; anything else is a screen mockup.
 * Keyword-based on purpose — the model decides the content, this only decides
 * which set of instructions it is given.
 */
export function inferKind(description: string): RenderKind {
  return /\b(diagram|flow ?chart|flow|architecture|blueprint|schematic|sequence|topology|graph|pipeline|wiring|network map)\b/i
    .test(description ?? "")
    ? "diagram"
    : "mockup";
}

/** The prompt that turns a request into one self-contained HTML document. */
export function renderMockupPrompt(description: string, kind: RenderKind): string {
  const shapeRules = kind === "diagram"
    ? [
      "- This is a DIAGRAM. Draw it with inline <svg>: labelled boxes or nodes, connecting",
      "  lines and arrows, a clear left-to-right or top-to-bottom flow. Real labels from the",
      "  request, not placeholders. Legible at a glance on a dark background."
    ]
    : [
      "- This is a UI MOCKUP. Lay out the interface with real, specific labels, fields,",
      "  buttons and structure from the request — a believable screen, never lorem-ipsum",
      "  filler. Use flexbox/grid so it fills the space and looks intentional."
    ];

  return [
    "You are rendering a single visual to be shown immediately inside a dark, Jarvis-style HUD.",
    "",
    `Show this: ${description}`,
    "",
    "Produce ONE complete HTML document, from <!doctype html> to </html>. Rules:",
    "- Everything inline. All CSS in one <style> tag; any graphics as inline <svg>.",
    "- Fully self-contained and offline: NO <link>, NO <script src>, NO web fonts, NO images",
    "  or styles loaded from the internet (no http:// or https:// in src, href or url()).",
    "  It must render identically with no network. Use system fonts and CSS shapes/SVG only.",
    "- Dark HUD theme: background near-black (#05070d), cyan/blue accents (#38d0ff), light",
    "  text (#eaf6ff), thin lines, a technical, holographic feel.",
    "- Fill the viewport (html, body { margin:0; height:100% }). Make it look finished.",
    ...shapeRules,
    "",
    "Output exactly this and nothing else:",
    "<!-- TITLE: a two-to-four word title -->",
    "<!doctype html> ... the whole document ...</html>",
    "",
    "No commentary before or after. Do not wrap it in code fences."
  ].join("\n");
}

/** Pull the title and the HTML document out of whatever the model returned. */
export function extractRendering(text: string): { title: string; html: string } | null {
  if (!text) return null;
  // Fenced output happens however firmly it is told not to; unwrap it.
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();

  const titleMatch = body.match(/<!--\s*TITLE:\s*(.+?)\s*-->/i);
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : "";

  // A full HTML document, or a bare <svg> we can wrap into one.
  const docStart = body.search(/<!doctype html|<html[\s>]/i);
  if (docStart !== -1) {
    const end = body.toLowerCase().lastIndexOf("</html>");
    if (end === -1) return null;
    return { title, html: body.slice(docStart, end + "</html>".length) };
  }

  const svg = body.match(/<svg[\s\S]*<\/svg>/i);
  if (svg) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>`
      + `html,body{margin:0;height:100%;background:#05070d;display:grid;place-items:center}`
      + `svg{max-width:100%;max-height:100%}</style></head><body>${svg[0]}</body></html>`;
    return { title, html };
  }

  return null;
}

/**
 * Reject a rendering before it is shown. The one that matters is the offline
 * rule: a document that pulls a font or a script from the internet is not
 * self-contained, would break on a machine with no network, and quietly sends
 * a request off this machine — none of which a local-first app should do.
 */
export function findRenderFault(html: string): string | null {
  if (!html) return "the model did not return a real HTML document";
  // The offline rule is checked first, and whatever the document's size: a
  // page that reaches the internet is rejected for that reason even if it is
  // also too short, because that is the more important thing to say.
  if (/<img[^>]+src\s*=\s*["']https?:/i.test(html)) return "it loads an image from the internet; a rendering must be self-contained";
  if (/<script[^>]+src\s*=\s*["']https?:/i.test(html)) return "it loads a script from the internet; a rendering must be self-contained";
  if (/<link[^>]+href\s*=\s*["']https?:/i.test(html)) return "it loads a stylesheet or font from the internet; a rendering must be self-contained";
  if (/@import|url\(\s*["']?https?:/i.test(html)) return "its CSS pulls in something from the internet; a rendering must be self-contained";
  if (html.length < 120) return "the model did not return a real HTML document";
  return null;
}

/** A filesystem-safe slug for a title, never empty. */
export function slugify(title: string): string {
  const slug = (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "rendering";
}

/** Save a rendering under the workspace and return its record. */
export function saveRendering(title: string, kind: RenderKind, html: string): Rendering {
  const dir = renderingsDir();
  mkdirSync(dir, { recursive: true });
  const name = slugify(title);
  // The title and kind ride along in a comment so a later listing can read them
  // back without a sidecar file to keep in sync.
  const header = `<!-- TITLE: ${title || name} -->\n<!-- KIND: ${kind} -->\n`;
  const withHeader = html.includes("TITLE:") ? html : header + html;
  writeFileSync(path.join(dir, `${name}.html`), withHeader, "utf8");
  return { name, title: title || name, kind, createdAt: new Date().toISOString() };
}

function readMeta(html: string): { title: string; kind: RenderKind } {
  const title = html.match(/<!--\s*TITLE:\s*(.+?)\s*-->/i)?.[1]?.trim() ?? "";
  const kind = /<!--\s*KIND:\s*diagram\s*-->/i.test(html) ? "diagram" : "mockup";
  return { title, kind };
}

/** Every saved rendering, newest first. */
export function listRenderings(): Rendering[] {
  let entries: string[];
  try {
    entries = readdirSync(renderingsDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".html"))
    .map((entry) => {
      const full = path.join(renderingsDir(), entry);
      const html = (() => { try { return readFileSync(full, "utf8"); } catch { return ""; } })();
      const meta = readMeta(html);
      const name = entry.replace(/\.html$/, "");
      return { name, title: meta.title || name, kind: meta.kind, createdAt: statSync(full).mtime.toISOString() };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** One rendering with its HTML, for display. Null when it is not there. */
export function readRendering(name: string): RenderingWithHtml | null {
  const clean = slugify(name);
  const full = path.join(renderingsDir(), `${clean}.html`);
  let html: string;
  try {
    html = readFileSync(full, "utf8");
  } catch {
    return null;
  }
  const meta = readMeta(html);
  return { name: clean, title: meta.title || clean, kind: meta.kind, createdAt: statSync(full).mtime.toISOString(), html };
}

/** The most recent rendering with its HTML, for the live panel. */
export function latestRendering(): RenderingWithHtml | null {
  const [newest] = listRenderings();
  return newest ? readRendering(newest.name) : null;
}
