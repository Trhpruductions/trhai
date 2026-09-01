import test from "node:test";
import assert from "node:assert/strict";
import {
  findScriptFault,
  frameCount,
  maxTotalSeconds,
  minSceneSeconds,
  parseVideoScript,
  sceneHtml,
  totalFrames,
  type VideoScript
} from "../src/videoScript.js";

function validScript(): VideoScript {
  return {
    title: "Demo",
    fps: 24,
    width: 1920,
    height: 1080,
    scenes: [
      { id: "intro", seconds: 3, narration: "Hello.", visual: { kind: "title", heading: "TRHAI" } },
      { id: "facts", seconds: 4, visual: { kind: "bullets", heading: "Facts", items: ["One", "Two"] } }
    ]
  };
}

test("parses a fenced JSON script", () => {
  const text = "Here you go:\n```json\n"
    + JSON.stringify({
      title: "Demo",
      fps: 30,
      scenes: [{ seconds: 2, visual: { kind: "title", heading: "Hi" } }]
    })
    + "\n```";

  const parsed = parseVideoScript(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.script.title, "Demo");
  assert.equal(parsed.script.fps, 30);
  assert.equal(parsed.script.scenes.length, 1);
  assert.equal(parsed.script.scenes[0].visual.kind, "title");
});

test("parses bare JSON with no fence", () => {
  const parsed = parseVideoScript(JSON.stringify({
    scenes: [{ seconds: 1, visual: { kind: "metric", label: "Uptime", value: "99.9%" } }]
  }));
  assert.equal(parsed.ok, true);
});

test("defaults fps, width and height when the model omits them", () => {
  const parsed = parseVideoScript(JSON.stringify({
    scenes: [{ seconds: 1, visual: { kind: "title", heading: "Hi" } }]
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.script.fps, 24);
  assert.equal(parsed.script.width, 1920);
  assert.equal(parsed.script.height, 1080);
});

test("rejects text with no JSON object at all", () => {
  const parsed = parseVideoScript("I could not write a script for that.");
  assert.equal(parsed.ok, false);
});

test("rejects invalid JSON", () => {
  const parsed = parseVideoScript("{ scenes: [ }");
  assert.equal(parsed.ok, false);
});

test("rejects a script with no scenes", () => {
  const parsed = parseVideoScript(JSON.stringify({ scenes: [] }));
  assert.equal(parsed.ok, false);
});

test("rejects a scene missing its visual", () => {
  const parsed = parseVideoScript(JSON.stringify({ scenes: [{ seconds: 2 }] }));
  assert.equal(parsed.ok, false);
});

test("rejects a scene with an unknown visual kind", () => {
  const parsed = parseVideoScript(JSON.stringify({
    scenes: [{ seconds: 2, visual: { kind: "hologram", heading: "Nope" } }]
  }));
  assert.equal(parsed.ok, false);
});

test("rejects bullets with no items", () => {
  const parsed = parseVideoScript(JSON.stringify({
    scenes: [{ seconds: 2, visual: { kind: "bullets", heading: "Empty", items: [] } }]
  }));
  assert.equal(parsed.ok, false);
});

test("findScriptFault passes a valid script", () => {
  assert.equal(findScriptFault(validScript()), null);
});

test("findScriptFault rejects a scene under the minimum duration", () => {
  const script = validScript();
  script.scenes[0].seconds = minSceneSeconds - 0.1;
  const fault = findScriptFault(script);
  assert.ok(fault && fault.includes("too short"));
});

test("findScriptFault rejects a script over the total time limit", () => {
  const script = validScript();
  script.scenes[0].seconds = maxTotalSeconds + 1;
  const fault = findScriptFault(script);
  assert.ok(fault && fault.includes("limit"));
});

test("findScriptFault rejects an unusable frame rate", () => {
  const script = validScript();
  script.fps = 0;
  assert.ok(findScriptFault(script));
});

test("findScriptFault rejects too small a frame", () => {
  const script = validScript();
  script.width = 100;
  script.height = 100;
  assert.ok(findScriptFault(script));
});

test("sceneHtml contains the scene's own text", () => {
  const html = sceneHtml(validScript().scenes[0], 0.5);
  assert.ok(html.includes("TRHAI"));
});

test("sceneHtml survives a scene with no narration", () => {
  const html = sceneHtml(validScript().scenes[1], 0.9);
  assert.ok(html.includes("Facts"));
  assert.ok(html.includes("One"));
});

test("sceneHtml escapes text so a script cannot inject markup", () => {
  const html = sceneHtml(
    { id: "x", seconds: 1, visual: { kind: "title", heading: "<script>alert(1)</script>" } },
    0.5
  );
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("frameCount is at least one frame even for a very short scene", () => {
  assert.equal(frameCount({ id: "x", seconds: 0.01, visual: { kind: "title", heading: "Hi" } }, 24), 1);
});

test("totalFrames sums every scene", () => {
  const script = validScript();
  const expected = frameCount(script.scenes[0], script.fps) + frameCount(script.scenes[1], script.fps);
  assert.equal(totalFrames(script), expected);
});
