import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The interface is served to this PC only, but a page is a page: what it may load and
// where it may send a request is said in a Content-Security-Policy, so that a flaw in
// a screen could not reach the internet with what it shows, and no other page may put
// this one in a frame. Everything this app needs is on this PC's own addresses - the
// service on its port, the apps TRH AI builds on theirs, the dev server's own socket -
// so those are what is allowed, and nothing further away.
//
// Next writes its own small inline scripts into every page (the data the screen is
// built from), and the theme is applied by one inline script before the first paint,
// so inline script is allowed; the policy's work here is the fences on sources and
// frames. In development Next's tooling needs eval as well.
//
// A policy cannot name an IPv6 address: the grammar has no form for one, and Chromium
// drops such a source with an error in the console. So ::1 is not listed. Nothing in
// the app addresses it - the desktop window loads 127.0.0.1, and a page opened as
// `localhost` is its own origin ('self') whichever address that name resolved to.
const loopback = "http://localhost:* http://127.0.0.1:*";
const loopbackSockets = "ws://localhost:* ws://127.0.0.1:*";
const dev = process.env.NODE_ENV !== "production";

export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${loopback}`,
  `media-src 'self' blob: ${loopback}`,
  `connect-src 'self' ${loopback} ${loopbackSockets}`,
  "font-src 'self'",
  `frame-src 'self' blob: ${loopback}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

export const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()" }
];

const nextConfig: NextConfig = {
  // The installer ships the standalone build: the server, the pages and only
  // the node_modules they trace to, run with no npm and no source tree. The
  // tracing root is the repo, because the workspace's dependencies are
  // hoisted there; without it Next guesses from the lockfile and warns.
  output: "standalone",
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  // The dev-only build badge defaults to a corner the app's own controls use
  // (the account menu, the sidebar's status chip); bottom-right is clear.
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  }
};

export default nextConfig;
