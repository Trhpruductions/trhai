import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Three files independently name the port the web client is served on:
//   - apps/web/vite.config.ts        (what Vite actually binds)
//   - scripts/run-web-dev.ps1        (what `npm run dev:web` launches)
//   - apps/desktop/src/main.ts       (what the desktop window waits for and loads)
//
// When they disagree the desktop shell waits on a port nothing is listening to,
// gives up, and renders its placeholder instead of the app — which presents as
// "the app is broken" with no error anywhere. dev-server.test.ts cannot catch it
// because it passes an explicit --port and so never exercises the defaults.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("vite, the dev:web launcher, and the desktop shell agree on the web port", () => {
  const viteMatch = read("apps/web/vite.config.ts").match(/port:\s*(\d{4,5})/);
  assert.ok(viteMatch, "Could not find a server port in vite.config.ts");

  const launcherMatch = read("scripts/run-web-dev.ps1").match(/\{\s*(\d{4,5})\s*\}\s*$/m);
  assert.ok(launcherMatch, "Could not find the default port in run-web-dev.ps1");

  const desktopMatch = read("apps/desktop/src/main.ts").match(/ASCEND_WEB_PORT\s*\?\?\s*(\d{4,5})/);
  assert.ok(desktopMatch, "Could not find ASCEND_WEB_PORT default in desktop main.ts");

  assert.equal(
    launcherMatch[1],
    viteMatch[1],
    "dev:web launches Vite on a different port than vite.config.ts binds"
  );
  assert.equal(
    desktopMatch[1],
    viteMatch[1],
    "The desktop shell waits on a different port than the web client is served on"
  );
});
