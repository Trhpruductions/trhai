import test from "node:test";
import assert from "node:assert/strict";
import nextConfig, { contentSecurityPolicy, securityHeaders } from "../next.config";

// Every page the interface serves carries these headers (next.config.ts). The
// policy's job is the fences: what a page may load from and send to is this PC's
// own addresses and nothing further away, no other page may frame this one, and
// the address a request came from is never told to anyone.

function directive(name: string): string[] {
  const found = contentSecurityPolicy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `) || part === name);
  assert.ok(found, `the policy has a ${name} directive`);
  return found.split(/\s+/).slice(1);
}

test("the policy keeps every source on this PC", () => {
  const loopback = ["http://localhost:*", "http://127.0.0.1:*"];
  assert.deepEqual(directive("default-src"), ["'self'"]);
  assert.deepEqual(directive("connect-src"), ["'self'", ...loopback, "ws://localhost:*", "ws://127.0.0.1:*"]);
  assert.deepEqual(directive("img-src"), ["'self'", "data:", "blob:", ...loopback]);
  assert.deepEqual(directive("media-src"), ["'self'", "blob:", ...loopback]);
  assert.deepEqual(directive("frame-src"), ["'self'", "blob:", ...loopback]);
  assert.deepEqual(directive("font-src"), ["'self'"]);
  assert.deepEqual(directive("worker-src"), ["'self'", "blob:"]);
  assert.deepEqual(directive("object-src"), ["'none'"]);
  assert.deepEqual(directive("base-uri"), ["'self'"]);
  assert.deepEqual(directive("form-action"), ["'self'"]);
  // No source anywhere names a host away from this PC, or any host at all.
  for (const source of contentSecurityPolicy.split(/[;\s]+/)) {
    assert.doesNotMatch(source, /^(https?|wss?):\/\/(?!localhost|127\.0\.0\.1|\[::1\])/, `${source} is not on this PC`);
    assert.notEqual(source, "*");
    assert.ok(!source.includes("["), `${source}: a policy cannot name an IPv6 address, and a browser drops the whole source`);
    assert.notEqual(source, "https:");
    assert.notEqual(source, "http:");
  }
});

test("no page may frame the interface, and eval is for development only", () => {
  assert.deepEqual(directive("frame-ancestors"), ["'none'"]);
  const script = directive("script-src");
  assert.ok(script.includes("'self'") && script.includes("'unsafe-inline'"), "Next's own inline scripts and the theme script run");
  // The test runner is not a production build, so eval is allowed here; the production
  // policy is the same text without it (next.config.ts reads NODE_ENV once, at load).
  assert.equal(script.includes("'unsafe-eval'"), process.env.NODE_ENV !== "production");
  assert.ok(!script.some((source) => source.startsWith("http")), "no script from any address, this PC's included");
  assert.deepEqual(directive("style-src"), ["'self'", "'unsafe-inline'"]);
});

test("the other headers say the same in the older words, and every page gets them", async () => {
  const byName = new Map(securityHeaders.map((header) => [header.key, header.value]));
  assert.equal(byName.get("Content-Security-Policy"), contentSecurityPolicy);
  assert.equal(byName.get("Referrer-Policy"), "no-referrer");
  assert.equal(byName.get("X-Frame-Options"), "DENY");
  assert.equal(byName.get("X-Content-Type-Options"), "nosniff");
  assert.match(byName.get("Permissions-Policy") ?? "", /camera=\(\)/);
  assert.match(byName.get("Permissions-Policy") ?? "", /geolocation=\(\)/);
  assert.match(byName.get("Permissions-Policy") ?? "", /payment=\(\)/);
  assert.ok(nextConfig.headers, "the config installs the headers");
  const rules = await nextConfig.headers();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].source, "/(.*)");
  assert.deepEqual(rules[0].headers, securityHeaders);
});
