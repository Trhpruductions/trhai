import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, isLocalOrigin } from "../src/services/originPolicy.js";

test("the app's own origins are allowed on any port", () => {
  // The web shell moves with ASCEND_WEB_PORT and the desktop shell follows it,
  // so the port cannot be pinned.
  assert.equal(isLocalOrigin("http://localhost:5173"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:5173"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:4173"), true);
  assert.equal(isLocalOrigin("http://localhost:3000"), true);
});

test("a remote site is refused", () => {
  // The reason this matters: any page the user visits can call the API on
  // localhost, and these endpoints carry no credentials.
  assert.equal(isLocalOrigin("https://example.com"), false);
  assert.equal(isLocalOrigin("http://evil.test"), false);
});

test("an origin that merely looks local is refused", () => {
  // The hostname is compared after parsing; a prefix or substring test would
  // have admitted both of these.
  assert.equal(isLocalOrigin("http://127.0.0.1.evil.com"), false);
  assert.equal(isLocalOrigin("http://localhost.evil.com"), false);
  assert.equal(isLocalOrigin("http://evil.com/?x=http://localhost"), false);
  assert.equal(isLocalOrigin("http://notlocalhost"), false);
});

test("a non-http scheme is refused", () => {
  assert.equal(isLocalOrigin("file://localhost"), false);
  assert.equal(isLocalOrigin("javascript:alert(1)"), false);
  assert.equal(isLocalOrigin("garbage"), false);
});

test("a request with no Origin header is allowed", () => {
  // curl, a server, or the desktop shell loading from file:. The browser only
  // sends Origin when a page makes the request, so refusing here would break
  // every non-browser caller and stop nothing.
  assert.equal(isAllowedOrigin(undefined), true);
});

test("CORS_ORIGIN overrides the default, including a list", () => {
  assert.equal(isAllowedOrigin("https://app.example.com", "https://app.example.com"), true);
  assert.equal(isAllowedOrigin("https://other.example.com", "https://app.example.com"), false);

  const list = "https://a.example.com, https://b.example.com";
  assert.equal(isAllowedOrigin("https://b.example.com", list), true);
  assert.equal(isAllowedOrigin("https://c.example.com", list), false);
});

test("an explicit star still means everyone, for anyone who really wants it", () => {
  assert.equal(isAllowedOrigin("https://example.com", "*"), true);
});

test("an empty CORS_ORIGIN falls back to the local default rather than allowing all", () => {
  // An unset or blank variable must not read as "no restrictions".
  assert.equal(isAllowedOrigin("https://example.com", ""), false);
  assert.equal(isAllowedOrigin("https://example.com", "   "), false);
  assert.equal(isAllowedOrigin("http://localhost:5173", ""), true);
});
