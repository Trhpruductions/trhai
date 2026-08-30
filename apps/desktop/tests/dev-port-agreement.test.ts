import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Ports named independently in several files, and what has to agree with what.
//
// The failure this exists for: when the desktop shell waits on a port nothing
// is listening to, it gives up and renders its placeholder instead of the app,
// which presents as "the app is broken" with no error anywhere.
// dev-server.test.ts cannot catch it, because it passes an explicit --port and
// so never exercises the defaults.
//
// What changed: the desktop shell no longer serves apps/web. It serves
// trhai-web, and its default was corrected from 5173 to 3210. That correction
// was made on its own, and it broke the app: the shell waited on 3210 while
// dev:web - the script the shell itself spawns - still started the old Vite
// client on 5173. Every launch outside scripts/launch-trhai.ps1 sat through the
// full 45s port wait and then rendered the placeholder.
//
// So the agreement that matters is between the shell and the launcher it runs,
// not between the launcher and a client it no longer starts. This test lives
// beside the shell for the same reason.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("the dev:web launcher and the desktop shell agree on the web port", () => {
  const launcherMatch = read("scripts/run-web-dev.ps1").match(/\{\s*(\d{4,5})\s*\}\s*$/m);
  assert.ok(launcherMatch, "Could not find the default port in run-web-dev.ps1");

  const desktopMatch = read("apps/desktop/src/main.ts").match(/ASCEND_WEB_PORT\s*\?\?\s*(\d{4,5})/);
  assert.ok(desktopMatch, "Could not find ASCEND_WEB_PORT default in desktop main.ts");

  // What scripts/launch-trhai.ps1 actually starts and hands the shell.
  const launchScript = read("scripts/launch-trhai.ps1");
  const servedMatch = launchScript.match(/workspace trhai-web -- -p (\d{4,5})/);
  assert.ok(servedMatch, "Could not find the port launch-trhai.ps1 serves trhai-web on");
  const handedMatch = launchScript.match(/ASCEND_WEB_PORT\s*=\s*"(\d{4,5})"/);
  assert.ok(handedMatch, "Could not find the ASCEND_WEB_PORT the launcher sets");

  assert.equal(
    launcherMatch[1],
    desktopMatch[1],
    "dev:web defaults to a different port than the desktop shell waits on, so "
      + "the shell starts the web client and then times out waiting for it"
  );
  assert.equal(
    handedMatch[1],
    servedMatch[1],
    "launch-trhai.ps1 serves trhai-web on one port and tells the shell another"
  );
  assert.equal(
    desktopMatch[1],
    servedMatch[1],
    "The desktop shell's default port is not the one trhai-web is served on, so "
      + "launching it without ASCEND_WEB_PORT set opens the wrong app or nothing"
  );
});
