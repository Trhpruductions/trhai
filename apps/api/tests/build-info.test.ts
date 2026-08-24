import test from "node:test";
import assert from "node:assert/strict";
import { getBuildInfo } from "../src/services/buildInfo.js";

// This repo is always a real git checkout in dev and in CI, so the git
// fields are expected to resolve — a null here would mean the lookup broke,
// not that git is unavailable. The one place null is the correct answer is a
// packaged build with no .git directory at all, which nothing here runs from.

test("build info reports the versions of all three workspaces", () => {
  const info = getBuildInfo();

  assert.match(info.apiVersion, /^\d+\.\d+\.\d+$/);
  assert.match(info.webVersion, /^\d+\.\d+\.\d+$/);
  assert.match(info.desktopVersion, /^\d+\.\d+\.\d+$/);
});

test("build info reports the real commit this process is running from", () => {
  const info = getBuildInfo();

  assert.match(info.gitCommit ?? "", /^[0-9a-f]{40}$/, "expected a full 40-character commit hash");
  assert.match(info.gitCommitShort ?? "", /^[0-9a-f]{7,}$/, "expected a short commit hash");
  assert.ok(info.gitBranch, "expected a branch name");
  assert.ok(info.gitCommitDate, "expected a commit date");
  assert.equal(typeof info.gitDirty, "boolean", "a real checkout can always answer whether it is dirty");
});

test("environment defaults to development, not silently to production", () => {
  // A blank NODE_ENV must never read as "production" — that is the one
  // direction a wrong default here would actually be dangerous.
  const info = getBuildInfo();
  assert.equal(info.environment, process.env.NODE_ENV?.trim() || "development");
});

test("serverStartedAt is a real, parseable timestamp", () => {
  const info = getBuildInfo();
  assert.ok(!Number.isNaN(new Date(info.serverStartedAt).getTime()));
});
