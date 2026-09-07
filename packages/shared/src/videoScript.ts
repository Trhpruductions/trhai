// A script for the motion-graphics studio: what to show, what to say, and
// for how long, before a single frame is rendered.
//
// This module does no I/O and touches no Electron, no ffmpeg, no filesystem.
// That is deliberate: parsing and validating a script is cheap to get right
// and cheap to test, and every mistake caught here is a render that never
// starts instead of one that runs for a minute and produces nothing. See
// docs/21-handoff.md for why this exists at all: real generative text-to-video
// needs 8-24GB of free VRAM this machine does not have, so the honest answer
// is a studio that scripts, narrates, renders and encodes locally instead.

/**
 * What a scene shows. A closed union rather than a free-form template name,
 * so an unknown kind is a parse failure here rather than a blank frame later
 * in `sceneHtml`, which only has a case for what is listed below.
 */
export type SceneVisual =
  | { kind: "title"; heading: string; subheading?: string }
  | { kind: "bullets"; heading: string; items: string[] }
  | { kind: "metric"; label: string; value: string; caption?: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "coreState"; label: string }
  | { kind: "imageFile"; path: string; caption?: string };

export type Scene = {
  id: string;
  seconds: number;
  /** Spoken over this scene. Absent scenes play silent, not skipped. */
  narration?: string;
  visual: SceneVisual;
};

export type VideoScript = {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: Scene[];
};

/** Below this a scene is a flash rather than something a viewer can read. */
export const minSceneSeconds = 0.5;
/** Above this the render is no longer "a short video" and should be split by the user. */
export const maxTotalSeconds = 600;

export type ScriptParse =
  | { ok: true; script: VideoScript }
  | { ok: false; reason: string };

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseVisual(raw: unknown): SceneVisual | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const kind = value.kind;

  switch (kind) {
    case "title": {
      const heading = asString(value.heading);
      if (!heading) return null;
      const subheading = asString(value.subheading);
      return subheading ? { kind: "title", heading, subheading } : { kind: "title", heading };
    }
    case "bullets": {
      const heading = asString(value.heading);
      const items = Array.isArray(value.items) ? value.items.filter((item) => typeof item === "string") : [];
      if (!heading || items.length === 0) return null;
      return { kind: "bullets", heading, items };
    }
    case "metric": {
      const label = asString(value.label);
      const metricValue = asString(value.value);
      if (!label || !metricValue) return null;
      const caption = asString(value.caption);
      return caption
        ? { kind: "metric", label, value: metricValue, caption }
        : { kind: "metric", label, value: metricValue };
    }
    case "code": {
      const code = typeof value.code === "string" ? value.code : undefined;
      if (!code) return null;
      const language = asString(value.language) ?? "text";
      return { kind: "code", language, code };
    }
    case "coreState": {
      const label = asString(value.label);
      if (!label) return null;
      return { kind: "coreState", label };
    }
    case "imageFile": {
      const path = asString(value.path);
      if (!path) return null;
      const caption = asString(value.caption);
      return caption ? { kind: "imageFile", path, caption } : { kind: "imageFile", path };
    }
    default:
      return null;
  }
}

function parseScene(raw: unknown, index: number): Scene | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const seconds = typeof value.seconds === "number" && Number.isFinite(value.seconds) ? value.seconds : null;
  if (seconds === null) return null;

  const visual = parseVisual(value.visual);
  if (!visual) return null;

  const id = asString(value.id) ?? `scene-${index + 1}`;
  const narration = asString(value.narration);

  return narration ? { id, seconds, narration, visual } : { id, seconds, visual };
}

/**
 * Read a script the model produced, as JSON.
 *
 * Unlike `appAuthor`'s delimited file format, a video script is one JSON
 * object rather than several files with bodies that must not be escaped, so
 * there is no equivalent reason to invent a text delimiter here - JSON is the
 * right shape for structured, nested data like this, and models produce it
 * reliably enough for an object this size.
 */
export function parseVideoScript(text: string): ScriptParse {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, reason: "No JSON object was found in the model's reply." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "The model's script was not valid JSON." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "The model returned no script." };
  }
  const value = parsed as Record<string, unknown>;

  const title = asString(value.title) ?? "Untitled";
  const fps = typeof value.fps === "number" && Number.isFinite(value.fps) ? value.fps : 24;
  const width = typeof value.width === "number" && Number.isFinite(value.width) ? value.width : 1920;
  const height = typeof value.height === "number" && Number.isFinite(value.height) ? value.height : 1080;

  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    return { ok: false, reason: "The script had no scenes." };
  }

  const scenes: Scene[] = [];
  for (let index = 0; index < value.scenes.length; index += 1) {
    const scene = parseScene(value.scenes[index], index);
    if (!scene) {
      return { ok: false, reason: `Scene ${index + 1} was missing its duration or its visual.` };
    }
    scenes.push(scene);
  }

  return { ok: true, script: { title, fps, width, height, scenes } };
}

/**
 * What is wrong with a script, checked before a single frame is rendered.
 *
 * Mirrors `findAppFault`'s role for generated apps: catch what is knowable
 * without doing the expensive thing, so a bad script fails in milliseconds
 * instead of after a minute of Electron and ffmpeg.
 */
export function findScriptFault(script: VideoScript): string | null {
  if (script.scenes.length === 0) return "the script has no scenes";
  if (!Number.isFinite(script.fps) || script.fps < 1 || script.fps > 60) {
    return `${script.fps} is not a usable frame rate`;
  }
  if (!Number.isFinite(script.width) || !Number.isFinite(script.height)
    || script.width < 320 || script.height < 240) {
    return `${script.width}x${script.height} is too small to render`;
  }

  let total = 0;
  for (const scene of script.scenes) {
    if (!Number.isFinite(scene.seconds) || scene.seconds < minSceneSeconds) {
      return `scene "${scene.id}" is under ${minSceneSeconds}s, too short to read`;
    }
    total += scene.seconds;
  }

  if (total > maxTotalSeconds) {
    return `the script totals ${Math.round(total)}s, over the ${maxTotalSeconds}s limit`;
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * How far into the scene this frame lands, eased in and out rather than
 * linear, so a title does not simply appear and vanish at the frame boundary.
 */
function ease(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped < 0.5 ? 2 * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
}

/**
 * The HTML for one scene at progress `t` (0..1 through that scene).
 *
 * Reuses the real visual language rather than generic slides: the same dark
 * HUD palette and display font as `apps/trhai-web/src/app/globals.css`, so a
 * rendered video looks like it came from this app rather than from a generic
 * template. Self-contained - no external stylesheet, no network fetch inside
 * the offscreen window - because the renderer loads this as a bare document.
 */
export function sceneHtml(scene: Scene, t: number): string {
  const opacity = Math.min(1, ease(t) * 6, ease(1 - t) * 6);
  const shift = (1 - ease(Math.min(1, ease(t) * 4))) * 24;

  const style = `
    <style>
      html, body { margin: 0; padding: 0; }
      body {
        width: 100vw; height: 100vh; overflow: hidden;
        background: #05070a;
        background-image:
          radial-gradient(circle at 20% 20%, rgba(53,199,255,0.10), transparent 55%),
          radial-gradient(circle at 80% 80%, rgba(53,199,255,0.06), transparent 55%);
        color: #eaf6ff;
        font-family: "Orbitron", ui-sans-serif, system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center;
      }
      .frame {
        opacity: ${opacity.toFixed(3)};
        transform: translateY(${shift.toFixed(2)}px);
        width: 84%;
        text-align: center;
      }
      .heading { font-size: 64px; font-weight: 700; letter-spacing: 0.02em; margin: 0 0 12px; }
      .subheading { font-size: 30px; color: #92aec2; margin: 0; }
      .items { text-align: left; margin: 32px auto 0; max-width: 900px; font-size: 34px; line-height: 1.7; }
      .items li { margin-bottom: 10px; }
      .items li::marker { color: #35c7ff; }
      .metric-label { font-size: 28px; color: #92aec2; letter-spacing: 0.08em; text-transform: uppercase; }
      .metric-value { font-size: 128px; font-weight: 700; color: #7fe3ff; margin: 8px 0; }
      .metric-caption { font-size: 26px; color: #92aec2; }
      pre {
        text-align: left; font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 26px; line-height: 1.6; background: #0a0f16; border: 1px solid rgba(120,200,255,0.28);
        border-radius: 12px; padding: 32px; max-width: 1100px; margin: 0 auto; overflow: hidden;
      }
      .core {
        width: 260px; height: 260px; border-radius: 50%;
        border: 2px solid rgba(120,200,255,0.45);
        box-shadow: 0 0 60px rgba(53,199,255,0.35), inset 0 0 40px rgba(53,199,255,0.25);
        display: flex; align-items: center; justify-content: center; margin: 0 auto 24px;
      }
      .core-inner { width: 140px; height: 140px; border-radius: 50%; background: rgba(53,199,255,0.18); }
      .caption { font-size: 24px; color: #92aec2; margin-top: 16px; }
    </style>`;

  let body: string;
  switch (scene.visual.kind) {
    case "title":
      body = `<div class="heading">${escapeHtml(scene.visual.heading)}</div>`
        + (scene.visual.subheading ? `<div class="subheading">${escapeHtml(scene.visual.subheading)}</div>` : "");
      break;
    case "bullets":
      body = `<div class="heading">${escapeHtml(scene.visual.heading)}</div>`
        + `<ul class="items">${scene.visual.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
      break;
    case "metric":
      body = `<div class="metric-label">${escapeHtml(scene.visual.label)}</div>`
        + `<div class="metric-value">${escapeHtml(scene.visual.value)}</div>`
        + (scene.visual.caption ? `<div class="metric-caption">${escapeHtml(scene.visual.caption)}</div>` : "");
      break;
    case "code":
      body = `<pre><code>${escapeHtml(scene.visual.code)}</code></pre>`;
      break;
    case "coreState":
      body = `<div class="core"><div class="core-inner"></div></div>`
        + `<div class="caption">${escapeHtml(scene.visual.label)}</div>`;
      break;
    case "imageFile":
      // The renderer resolves `path` to a `file://` URL itself; this module
      // does no filesystem access, so the tag is emitted with the path as
      // given and it is the caller's job to have already checked it exists.
      body = `<img src="${escapeHtml(scene.visual.path)}" style="max-width:90%;max-height:70vh;border-radius:12px;" />`
        + (scene.visual.caption ? `<div class="caption">${escapeHtml(scene.visual.caption)}</div>` : "");
      break;
    default: {
      const exhaustive: never = scene.visual;
      throw new Error(`Unhandled scene visual: ${JSON.stringify(exhaustive)}`);
    }
  }

  return `<!doctype html><html><head>${style}</head><body><div class="frame">${body}</div></body></html>`;
}

/** How many frames a scene needs at a given frame rate. At least one. */
export function frameCount(scene: Scene, fps: number): number {
  return Math.max(1, Math.round(scene.seconds * fps));
}

/** Total scene count as frames, for progress reporting. */
export function totalFrames(script: VideoScript): number {
  return script.scenes.reduce((sum, scene) => sum + frameCount(scene, script.fps), 0);
}

/**
 * The instruction given to the local model to write a scene script.
 *
 * Mirrors `authorPrompt` in `appAuthor.ts`: explicit about the shape, explicit
 * about the closed set of visual kinds, and asked for as one JSON object
 * rather than the delimited file format that exists specifically to avoid
 * escaping — there is nothing here that needs escaping the way a program's
 * source does.
 */
export function videoScriptPrompt(description: string): string {
  return [
    "You are writing a script for a short, local motion-graphics video. Output ONLY a single JSON",
    "object, no prose before or after it and no code fence.",
    "",
    `The user asked for: ${description}`,
    "",
    "Shape:",
    '{ "title": string, "fps": number (12-30), "width": number, "height": number,',
    '  "scenes": [ { "id": string, "seconds": number, "narration"?: string, "visual": <see below> } ] }',
    "",
    "Each scene's \"visual\" must be exactly one of these, by \"kind\":",
    '  { "kind": "title", "heading": string, "subheading"?: string }',
    '  { "kind": "bullets", "heading": string, "items": string[] }',
    '  { "kind": "metric", "label": string, "value": string, "caption"?: string }',
    '  { "kind": "code", "language": string, "code": string }',
    '  { "kind": "coreState", "label": string }',
    "",
    "Rules:",
    "- Every scene needs at least 0.5 seconds and the whole script under 10 minutes.",
    "- Write real narration for scenes that should be spoken; omit \"narration\" for a silent scene.",
    "- No scene visual besides the five kinds listed above; nothing else will render.",
    "- Make it specific to what was asked for, not a generic template."
  ].join("\n");
}
