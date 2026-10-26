// The installed app's Electron, started to print a document or draw video
// frames instead of being the app (see renderMode.ts). It loads the API's own
// renderer script as its main process and does nothing else: no window of its
// own, no services, no update check, and no lock against the app that is
// running, which is what started it.

import { mkdirSync } from "node:fs";
import { app } from "electron";
import { pathToFileURL } from "node:url";
import type { RenderRequest } from "./renderMode.js";

export async function runRenderer(request: RenderRequest): Promise<void> {
  // A profile of its own, set before the app is ready: sharing the running app's
  // would put two processes on one set of caches and databases.
  mkdirSync(request.userData, { recursive: true });
  app.setPath("userData", request.userData);
  // The script takes its manifest from the last argument it was started with,
  // as it does when the `electron` package runs it directly.
  await import(pathToFileURL(request.script).href);
}
