import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderRequest, rendererScriptName } from "../src/renderMode.js";

// How the installed app tells "start the app" from "print this document": by what the API puts in the
// environment, and nothing else about the way it was started.

const resources = path.join("C:", "Users", "x", "AppData", "Local", "Programs", "trh-ai", "resources");

test("an ordinary start is the app, whatever else is in the environment", () => {
  assert.equal(renderRequest({}, resources), null);
  assert.equal(renderRequest({ ELECTRON_RUN_AS_NODE: "1", PORT: "4000", TRHAI_RENDER_USER_DATA: "D:/profile" }, resources), null, "a profile folder alone is not a request");
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: "" }, resources), null);
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: "   " }, resources), null);
});

test("a manifest in the environment is a request to render, with the script from the install's own resources", () => {
  const manifest = path.join("D:", "scratch", "trhai-pdf-abc", "manifest.json");
  const request = renderRequest({ TRHAI_RENDER_MANIFEST: manifest }, resources);
  assert.ok(request);
  assert.equal(request.manifest, manifest);
  assert.equal(request.script, path.join(resources, "api", "frameRendererElectron.mjs"));
  assert.equal(rendererScriptName, "frameRendererElectron.mjs", "the name the API's bundle gives it");
});

test("the profile is the one the API named, or one beside the manifest, never the running app's", () => {
  const manifest = path.join("D:", "scratch", "job", "manifest.json");
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: manifest, TRHAI_RENDER_USER_DATA: "E:/mine/profile" }, resources)?.userData, "E:/mine/profile");
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: manifest }, resources)?.userData, path.join("D:", "scratch", "job", "profile"));
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: manifest, TRHAI_RENDER_USER_DATA: "  " }, resources)?.userData, path.join("D:", "scratch", "job", "profile"));
});

test("what the manifest is called is taken as given, spaces trimmed", () => {
  assert.equal(renderRequest({ TRHAI_RENDER_MANIFEST: "  D:/scratch/job/manifest.json " }, resources)?.manifest, "D:/scratch/job/manifest.json");
});
