// The shell's entry point (package.json "main"): the app, or, when the API has
// asked this same Electron to print a document or draw frames, the renderer and
// nothing else. Why that has to be decided before the app starts is in
// renderMode.ts. `electron dist/main.js`, which the checkout's launcher uses,
// goes straight to the app and never comes through here.

import { renderRequest } from "./renderMode.js";

const request = renderRequest(process.env, process.resourcesPath);

if (request) {
  const { runRenderer } = await import("./renderMain.js");
  await runRenderer(request);
} else {
  await import("./main.js");
}
