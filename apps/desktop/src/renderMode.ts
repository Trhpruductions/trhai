// Whether this process was started to render and not to be the app.
//
// The API prints documents as PDFs and draws video frames with a window of
// Electron's (apps/api/src/services/frameRenderer.ts). Checked out, that is the
// `electron` package's own binary and the script it is handed. Installed, the
// only Electron there is TRH AI's own, and a packaged Electron runs its own app
// whatever script it is handed (`onlyLoadAppFromAsar`): started that way it
// would have opened a second TRH AI. So the API says what it wants through the
// environment, and the entry point (entry.ts) runs the renderer instead of the
// app. Kept free of Electron so it can be tested without it.

import path from "node:path";

export type RenderRequest = {
  /** The job's manifest: what to print or draw, and where to put it. */
  manifest: string;
  /** A profile folder for this process alone, so that it does not share the running app's. */
  userData: string;
  /** The renderer script the install carries beside the API. */
  script: string;
};

/** The name the API's bundle gives the renderer script, in the install's `resources\api`. */
export const rendererScriptName = "frameRendererElectron.mjs";

/**
 * What this process was asked to render, from its environment; null when it is
 * the app. `resourcesPath` is where the install keeps the API (process.resourcesPath).
 */
export function renderRequest(env: NodeJS.ProcessEnv, resourcesPath: string): RenderRequest | null {
  const manifest = env.TRHAI_RENDER_MANIFEST?.trim();
  if (!manifest) return null;
  const userData = env.TRHAI_RENDER_USER_DATA?.trim() || path.join(path.dirname(manifest), "profile");
  return { manifest, userData, script: path.join(resourcesPath, "api", rendererScriptName) };
}
