import test from "node:test";
import assert from "node:assert/strict";
import {
  authorPrompt, compiles, fileMarker, findAppFault, isSafePath, maxFiles, parseAuthoredFiles,
  pickAuthorModel, findForeignImport, findHangingPromise } from "../src/services/appAuthor.js";

// This parses text produced by a model and turns it into files on disk. Every
// case here is about the same question: can something the model said end up
// written somewhere it should not be, or in a shape that cannot run?

const server = { path: "server.js", content: "require('http').createServer().listen(3000);" };

test("a clean file list is accepted", () => {
  const result = parseAuthoredFiles(JSON.stringify([
    server,
    { path: "public/index.html", content: "<h1>hi</h1>" }
  ]));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.files.map((f) => f.path), ["server.js", "public/index.html"]);
});

test("prose and code fences around the array are recovered, not refused", () => {
  // Models add "Here you go:" and fences however firmly they are told not to.
  const wrapped = "Here is your app:\n\n```json\n" + JSON.stringify([server]) + "\n```\nHope that helps!";
  const result = parseAuthoredFiles(wrapped);
  assert.equal(result.ok, true);
});

test("malformed JSON is refused rather than repaired", () => {
  // A file list that needed guessing to parse is not one to write to disk.
  const result = parseAuthoredFiles('[{"path": "server.js", "content": ');
  assert.equal(result.ok, false);
});

test("a path climbing out of the folder is refused", () => {
  const result = parseAuthoredFiles(JSON.stringify([
    server,
    { path: "../../.ssh/authorized_keys", content: "ssh-rsa AAA" }
  ]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unsafe|unsupported/i);
});

test("a Windows-style traversal is refused too", () => {
  // Normalising backslashes first is what stops this getting past a check that
  // only looks for forward slashes.
  assert.equal(isSafePath("..\\..\\windows\\system32\\evil.js"), false);
  assert.equal(isSafePath("sub\\..\\..\\out.js"), false);
});

test("absolute paths are refused, in both spellings", () => {
  assert.equal(isSafePath("/etc/passwd.txt"), false);
  assert.equal(isSafePath("C:/Windows/System32/drivers/etc/hosts.txt"), false);
});

test("an executable or unknown extension is refused", () => {
  assert.equal(isSafePath("install.exe"), false);
  assert.equal(isSafePath("run.sh"), false);
  assert.equal(isSafePath("payload.bat"), false);
  assert.equal(isSafePath("lib.dll"), false);
});

test("a file with no extension is refused", () => {
  assert.equal(isSafePath("Makefile"), false);
});

test("the ordinary shapes an app needs are allowed", () => {
  for (const path of ["server.js", "public/index.html", "package.json", "README.md", "style.css"]) {
    assert.equal(isSafePath(path), true, `should allow ${path}`);
  }
});

test("the same file listed twice is refused", () => {
  const result = parseAuthoredFiles(JSON.stringify([server, server]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /twice/i);
});

test("an app with nothing to run is refused", () => {
  const result = parseAuthoredFiles(JSON.stringify([{ path: "README.md", content: "# hi" }]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /server\.js/);
});

test("a runaway generation cannot fill the workspace", () => {
  const many = Array.from({ length: maxFiles + 3 }, (_, i) => ({ path: `f${i}.js`, content: "x" }));
  const result = parseAuthoredFiles(JSON.stringify(many));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /limit/i);
});

test("an enormous single file is refused", () => {
  const huge = { path: "server.js", content: "x".repeat(70 * 1024) };
  const result = parseAuthoredFiles(JSON.stringify([huge]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /larger than/i);
});

test("an entry that is not a file is refused", () => {
  const result = parseAuthoredFiles(JSON.stringify([server, "just a string"]));
  assert.equal(result.ok, false);
});

test("an entry missing its content is refused", () => {
  const result = parseAuthoredFiles(JSON.stringify([{ path: "server.js" }]));
  assert.equal(result.ok, false);
});

test("an empty list is refused", () => {
  assert.equal(parseAuthoredFiles("[]").ok, false);
});

test("a reply with no array at all is refused", () => {
  assert.equal(parseAuthoredFiles("I cannot build that, sorry.").ok, false);
});

test("the prompt tells the model the constraints that actually apply", () => {
  // The workspace runs plain Node with no install step, so an app that opens
  // by asking for `npm install express` is one the user cannot run.
  const prompt = authorPrompt("a snake game");
  assert.match(prompt, /a snake game/);
  assert.match(prompt, /no npm packages|No npm packages/i);
  assert.match(prompt, /smoke/i);
  assert.match(prompt, /=== FILE:/);
  assert.match(prompt, /Do not escape quotes or newlines/i);
});

// The delimited format, which is what the prompt now asks for.
//
// It exists because asking a model for JSON means asking it to escape every
// quote and newline in a program, and the first real generation came back as
// `},"{"path":` - one stray quote, the whole reply unusable.

const marker = (path: string) => `${fileMarker} ${path}`;

test("files separated by markers are read verbatim", () => {
  const reply = [
    marker("server.js"),
    "const http = require('http');",
    'http.createServer((req, res) => res.end("hi")).listen(3000);',
    marker("public/index.html"),
    '<h1 class="title">Snake</h1>'
  ].join("\n");

  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.files.map((f) => f.path), ["server.js", "public/index.html"]);
  // The exact quotes and newlines that were sent, with nothing unescaped.
  assert.match(result.files[0].content, /require\('http'\)/);
  assert.equal(result.files[1].content, '<h1 class="title">Snake</h1>');
});

test("a marker with trailing equals signs still names the file", () => {
  const reply = `${fileMarker} server.js ===\nrequire('http');`;
  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.files[0].path, "server.js");
});

test("preamble before the first marker is discarded", () => {
  const reply = `Sure! Here is your app.\n\n${marker("server.js")}\nrequire('http');`;
  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.files.length, 1);
});

test("a file the model wrapped in a fence anyway is unwrapped", () => {
  const reply = `${marker("server.js")}\n\`\`\`js\nrequire('http');\n\`\`\``;
  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.files[0].content, "require('http');");
});

test("the path rules apply to the delimited format too", () => {
  // The shared validation is the point: two parsers with two copies of the
  // path rules is two places for one of them to fall behind.
  const reply = `${marker("server.js")}\nx\n${marker("../escape.js")}\ny`;
  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unsafe|unsupported/i);
});

test("a delimited reply with nothing to run is refused", () => {
  const reply = `${marker("README.md")}\n# hello`;
  const result = parseAuthoredFiles(reply);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /server\.js/);
});

// What is wrong with a generated app, checked without running it.

test("a server that exits on its own is caught", () => {
  // Observed, not imagined: asked for a smoke check, the model put one at the
  // bottom of server.js too, so the server booted, requested its own page and
  // called process.exit(0). It logged "Server running at ..." and was gone.
  const files = [{
    path: "server.js",
    content: "const http=require('http');\nhttp.createServer(()=>{}).listen(3000);\n"
      + "http.get('http://localhost:3000', r => process.exit(r.statusCode === 200 ? 0 : 1));"
  }];
  assert.match(String(findAppFault(files)), /exits on its own/);
});

test("a server that just serves is fine", () => {
  const files = [
    { path: "server.js", content: "const http=require('http');\nhttp.createServer((q,s)=>s.end('hi')).listen(3000);" },
    { path: "public/index.html", content: "<h1>hi</h1>" }
  ];
  assert.equal(findAppFault(files), null);
});

test("a file that does not parse is caught before it is called working", () => {
  const files = [{ path: "server.js", content: "const x = (((;" }];
  assert.match(String(findAppFault(files)), /does not parse/);
});

test("a broken helper file is caught too, not just the entry point", () => {
  const files = [
    { path: "server.js", content: "require('http').createServer().listen(3000);" },
    { path: "game.js", content: "function ( { broken" }
  ];
  assert.match(String(findAppFault(files)), /game\.js.*does not parse/);
});

test("invalid package.json is caught", () => {
  const files = [
    { path: "server.js", content: "require('http').createServer().listen(3000);" },
    { path: "package.json", content: '{ "name": "x", }}' }
  ];
  assert.match(String(findAppFault(files)), /not valid JSON/);
});

test("smoke.js is allowed to exit - that is its whole job", () => {
  // Only the entry point is checked for self-termination. A smoke check that
  // could not exit non-zero would be useless.
  const files = [
    { path: "server.js", content: "require('http').createServer().listen(3000);" },
    { path: "smoke.js", content: "process.exit(0);" }
  ];
  assert.equal(findAppFault(files), null);
});

test("code using CommonJS top-level constructs still compiles", () => {
  // The check wraps the source in a function, so a bare `return` - legal in a
  // CommonJS module - must not be mistaken for a syntax error.
  assert.equal(compiles("if (process.env.SKIP) { return; }\nconsole.log('x');"), true);
});

// Which model writes the app.

test("a coding model is chosen over the chat default", () => {
  // Measured: the 1.9GB general model did not finish a snake game in five
  // minutes; qwen2.5-coder:7b wrote one in thirty seconds.
  assert.equal(
    pickAuthorModel(["vexora:latest", "qwen2.5-coder:7b", "qwen2.5:3b"], "vexora:latest"),
    "qwen2.5-coder:7b"
  );
});

test("the configured model is used when nothing coding-specific is installed", () => {
  // A slow attempt still beats refusing to try.
  assert.equal(pickAuthorModel(["vexora:latest", "qwen2.5:3b"], "vexora:latest"), "vexora:latest");
});

test("a general model whose name merely contains the word code is not mistaken for one", () => {
  assert.equal(pickAuthorModel(["mycodebase-chat:7b"], "vexora:latest"), "vexora:latest");
});

test("the first listed coding preference wins", () => {
  assert.equal(
    pickAuthorModel(["codellama:13b", "qwen2.5-coder:7b"], "vexora:latest"),
    "qwen2.5-coder:7b"
  );
});

test("the prompt tells the model the smoke check must wait for the server", () => {
  // The failure this prevents, seen live: a generated smoke.js spawned the
  // server and requested the page in the same tick, got ECONNREFUSED, and
  // exited 1. The app worked perfectly and was reported as broken.
  const prompt = authorPrompt("a pomodoro timer");
  assert.match(prompt, /retry|wait for the server/i);
  assert.match(prompt, /ECONNREFUSED/);
  assert.match(prompt, /SMOKE_PORT/);
});

// Generated apps run on the standard library alone.

test("an npm dependency is rejected, and named", () => {
  // Verbatim from a live build. Asked for a celsius-to-fahrenheit converter,
  // the model put require('wait-port') in smoke.js. The app was written, its
  // own smoke test died with "Cannot find module 'wait-port'", and the model's
  // next move was to npm install it.
  const fault = findAppFault([
    { path: "server.js", content: "const http = require('http');\nhttp.createServer(() => {}).listen(3000);\n" },
    { path: "smoke.js", content: "const waitPort = require('wait-port');\n" }
  ]);

  assert.ok(fault, "a foreign import must be a fault");
  assert.match(fault!, /smoke\.js/);
  assert.match(fault!, /wait-port/, "the retry has to know which import to remove");
});

test("node's own modules are fine, however they are spelled", () => {
  for (const line of [
    "const fs = require('fs');",
    "const fs = require('node:fs');",
    "const { readFile } = require('fs/promises');",
    "import http from 'node:http';",
    "import { join } from 'path';",
    "const helper = require('./helper.js');",
    "const shared = require('../shared/util.js');"
  ]) {
    assert.equal(findForeignImport(line), null, `should allow: ${line}`);
  }
});

test("a package is spotted whichever syntax introduces it", () => {
  assert.equal(findForeignImport("const e = require('express');"), "express");
  assert.equal(findForeignImport("import express from 'express';"), "express");
  assert.equal(findForeignImport("import 'dotenv/config';"), "dotenv/config");
  assert.equal(findForeignImport('const x = require("lodash");'), "lodash");
});

test("a clean app has no fault", () => {
  const fault = findAppFault([
    {
      path: "server.js",
      content: "const http = require('http');\nconst { join } = require('node:path');\n"
        + "http.createServer((_q, s) => s.end('ok')).listen(3000);\n"
    },
    { path: "smoke.js", content: "const http = require('http');\nhttp.get('http://127.0.0.1:3000', () => {});\n" }
  ]);
  assert.equal(fault, null);
});

// A promise that can never settle.

test("a promise whose resolve is never called is a fault", () => {
  // Verbatim shape from a live build. The server was fine; the smoke test hung
  // here forever and the build reported "could not verify within 20s", making a
  // working app look broken.
  const hanging = [
    "async function startServer() {",
    "  const child = spawn('node', ['server.js']);",
    "  return new Promise((resolve, reject) => {",
    "    child.stderr.on('data', () => reject(new Error('failed')));",
    "    return child;",
    "  });",
    "}"
  ].join("\n");

  assert.equal(findHangingPromise(hanging), true);

  const fault = findAppFault([
    { path: "server.js", content: "const http = require('http');\nhttp.createServer(()=>{}).listen(3000);\n" },
    { path: "smoke.js", content: hanging }
  ]);
  assert.ok(fault);
  assert.match(fault!, /resolve is never called/);
});

test("passing resolve as a callback still counts as using it", () => {
  // The commonest delay helper there is. It never writes "resolve(", so a check
  // looking for a call rather than a mention would reject correct code.
  assert.equal(
    findHangingPromise("const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));"),
    false
  );
});

test("ordinary promise shapes are not faults", () => {
  for (const fine of [
    "new Promise((resolve) => { resolve(42); })",
    "new Promise((ok, no) => { if (x) ok(1); else no(new Error('e')); })",
    "new Promise((resolve, reject) => { fs.readFile(p, (e, d) => e ? reject(e) : resolve(d)); })",
    "new Promise((resolve) => { server.listen(0, () => resolve(server)); })"
  ]) {
    assert.equal(findHangingPromise(fine), false, `should allow: ${fine}`);
  }
});

test("a bracket inside a string does not confuse the scan", () => {
  // The paren matcher is string-aware so a message containing "(" cannot
  // truncate the executor and turn correct code into a reported fault.
  const code = "new Promise((resolve) => { log('starting (phase 1)'); resolve(1); })";
  assert.equal(findHangingPromise(code), false);
});
