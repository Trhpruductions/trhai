import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDesktopBuildInfo } from "../src/buildInfo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/desktop/tests -> repo root, a real checkout in dev and in CI alike.
const repoRoot = path.resolve(__dirname, "../../..");

test("reports the packaged/dev state and the values it was given, not guesses", () => {
  const info = getDesktopBuildInfo({
    version: "9.9.9",
    packaged: false,
    appPath: "/fake/app/path",
    workspaceRoot: repoRoot
  });

  assert.equal(info.version, "9.9.9");
  assert.equal(info.environment, "development");
  assert.equal(info.appPath, "/fake/app/path");
});

test("packaged: true reads as production", () => {
  const info = getDesktopBuildInfo({
    version: "1.0.0",
    packaged: true,
    appPath: "/fake",
    workspaceRoot: repoRoot
  });

  assert.equal(info.environment, "production");
});

test("resolves the real commit this checkout is on", () => {
  const info = getDesktopBuildInfo({
    version: "0.0.0",
    packaged: false,
    appPath: "/fake",
    workspaceRoot: repoRoot
  });

  assert.match(info.gitCommit ?? "", /^[0-9a-f]{40}$/);
  assert.match(info.gitCommitShort ?? "", /^[0-9a-f]{7,}$/);
  assert.equal(typeof info.gitDirty, "boolean");
});

test("launchedVia reports what actually started it, not a guess", () => {
  const viaLauncher = getDesktopBuildInfo({
    version: "0.0.0", packaged: false, appPath: "/fake", workspaceRoot: repoRoot,
    launchedViaEnv: "Launch-Vexora.bat"
  });
  assert.equal(viaLauncher.launchedVia, "Launch-Vexora.bat");

  const direct = getDesktopBuildInfo({
    version: "0.0.0", packaged: false, appPath: "/fake", workspaceRoot: repoRoot,
    launchedViaEnv: ""
  });
  assert.match(direct.launchedVia, /not started from Launch-Vexora\.bat/);
});

test("an invalid workspace root fails the git lookups without throwing", () => {
  const info = getDesktopBuildInfo({
    version: "0.0.0",
    packaged: false,
    appPath: "/fake",
    workspaceRoot: path.join(repoRoot, "definitely-not-a-real-directory")
  });

  assert.equal(info.gitCommit, null);
  assert.equal(info.gitDirty, null);
});
