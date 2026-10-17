import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedHost, isAllowedOrigin, isLocalOrigin, webAppPort } from "../src/services/originPolicy.js";

test("the app's own origin is allowed, on the web app's port", () => {
  assert.equal(isLocalOrigin("http://localhost:3210"), true);
  assert.equal(isLocalOrigin("http://127.0.0.1:3210"), true);
  assert.equal(isLocalOrigin("http://[::1]:3210"), true);
});

test("another port on this PC is not the app: the apps TRH AI builds run on ports of their own", () => {
  assert.equal(isLocalOrigin("http://127.0.0.1:5173"), false);
  assert.equal(isLocalOrigin("http://localhost:4173"), false);
  assert.equal(isLocalOrigin("http://localhost"), false);
});

test("the port follows ASCEND_WEB_PORT, as the web app and the desktop shell do", () => {
  assert.equal(webAppPort({}), "3210");
  assert.equal(webAppPort({ ASCEND_WEB_PORT: "5180" }), "5180");
  assert.equal(isLocalOrigin("http://localhost:5180", "5180"), true);
  assert.equal(isLocalOrigin("http://localhost:3210", "5180"), false);
});

test("only requests addressed to this PC are answered: a rebound domain is not", () => {
  for (const host of ["127.0.0.1:4000", "localhost:4000", "[::1]:4000", "LOCALHOST:4000", "localhost"]) {
    assert.equal(isAllowedHost(host), true, host);
  }
  // A page that pointed its own name at 127.0.0.1 still sends its own name.
  for (const host of ["evil.example:4000", "127.0.0.1.evil.example:4000", "localhost.evil.example:4000", "192.168.1.20:4000", "", undefined]) {
    assert.equal(isAllowedHost(host), false, String(host));
  }
  // With other devices let in, an address typed as numbers reaches it too; a name still does not.
  assert.equal(isAllowedHost("192.168.1.20:4000", { otherDevices: true }), true);
  assert.equal(isAllowedHost("[fe80::1]:4000", { otherDevices: true }), true);
  assert.equal(isAllowedHost("evil.example:4000", { otherDevices: true }), false);
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
  assert.equal(isAllowedOrigin("http://localhost:3210", ""), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", ""), false);
});
