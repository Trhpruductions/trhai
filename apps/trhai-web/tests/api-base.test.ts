import test from "node:test";
import assert from "node:assert/strict";
import { resolveApiBaseUrl } from "../src/lib/api.js";

// The API's address follows the page's own spelling of this PC, so the two are one site to the
// browser. The installed app's window at 127.0.0.1:3210 calling localhost:4000 was refused as
// cross-site from 0.1.10 to 0.1.11.

test("the API is reached at the page's own spelling of this PC", () => {
  assert.equal(resolveApiBaseUrl(undefined, { hostname: "127.0.0.1" }), "http://127.0.0.1:4000");
  assert.equal(resolveApiBaseUrl(undefined, { hostname: "localhost" }), "http://localhost:4000");
  assert.equal(resolveApiBaseUrl(undefined, { hostname: "LocalHost" }), "http://localhost:4000");
  assert.equal(resolveApiBaseUrl(undefined, { hostname: "[::1]" }), "http://[::1]:4000");
});

test("a configured address wins, and a page from anywhere else, or none, gets the old default", () => {
  assert.equal(resolveApiBaseUrl("http://127.0.0.1:4410", { hostname: "localhost" }), "http://127.0.0.1:4410");
  assert.equal(resolveApiBaseUrl(" ", { hostname: "127.0.0.1" }), "http://127.0.0.1:4000", "blank is not configured");
  assert.equal(resolveApiBaseUrl(undefined, null), "http://localhost:4000", "rendered on the server");
  assert.equal(resolveApiBaseUrl(undefined, { hostname: "trhai.example" }), "http://localhost:4000");
});
