import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { crossSiteVerdict } from "../src/services/requestOrigin.js";

// A page that is not the app must not make the service do anything - not only must it
// be unable to read the answer (CORS), the request itself must be refused, whatever its
// method, because arming machine access, starting a download or fetching a page on the
// model's behalf does its work whether or not anyone reads the reply.

const { createApp } = await import("../src/server.js");

test("a request from another page is refused by its Origin, and the app's own and a non-browser caller pass", () => {
  const refused = (origin: string, method = "POST") => crossSiteVerdict({ origin }, method, "/v1/commands/arm").refused;
  assert.equal(refused("http://127.0.0.1:5123"), true, "an app TRH AI built, on its own port");
  assert.equal(refused("https://evil.example"), true);
  assert.equal(refused("http://127.0.0.1.evil.example:3210"), true);
  assert.equal(refused("null"), true, "a sandboxed frame or a file: page");
  assert.equal(refused("http://localhost:5123", "GET"), true, "a GET that does work is refused too");
  assert.equal(refused("http://localhost:3210"), false, "the app");
  assert.equal(refused("http://127.0.0.1:3210"), false);
  assert.equal(crossSiteVerdict({}, "POST", "/v1/commands/arm").refused, false, "no Origin: curl, the launcher, the shell");
  assert.equal(crossSiteVerdict({ origin: "https://evil.example" }, "OPTIONS", "/v1/assist").refused, false, "a preflight is cors()'s to answer");
  assert.equal(crossSiteVerdict({ origin: "https://site.example" }, "POST", "/v1/x", "https://site.example").refused, false, "CORS_ORIGIN still names who may");
});

test("a subresource placed on a page from another site is refused, and one on the app's own pages is not", () => {
  assert.equal(crossSiteVerdict({ secFetchSite: "cross-site", secFetchDest: "image" }, "GET", "/health").refused, true);
  assert.equal(crossSiteVerdict({ secFetchSite: "Cross-Site" }, "GET", "/v1/files/raw").refused, true);
  assert.equal(crossSiteVerdict({ secFetchSite: "same-site", secFetchDest: "image" }, "GET", "/v1/files/raw").refused, false, "the app's own media");
  assert.equal(crossSiteVerdict({ secFetchSite: "same-origin", secFetchDest: "empty" }, "GET", "/v1/files").refused, false);
  assert.equal(crossSiteVerdict({ secFetchSite: "none" }, "GET", "/v1/files").refused, false, "a URL typed into the address bar");
});

test("the routes that fetch from the internet answer only a fetch or XHR, never an image or script tag on any page", () => {
  const read = "/v1/web/read";
  assert.equal(crossSiteVerdict({ secFetchSite: "same-site", secFetchDest: "image" }, "GET", read).refused, true, "an <img> on an app TRH AI built");
  assert.equal(crossSiteVerdict({ secFetchSite: "same-origin", secFetchDest: "script" }, "GET", "/v1/web/search").refused, true);
  assert.equal(crossSiteVerdict({ secFetchSite: "same-site", secFetchDest: "empty" }, "GET", read).refused, false, "the app's own fetch");
  assert.equal(crossSiteVerdict({}, "GET", read).refused, false, "a non-browser caller");
  assert.equal(crossSiteVerdict({ secFetchSite: "same-site", secFetchDest: "document" }, "GET", read).refused, true, "nor a tab opened to it");
});

function ask(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

test("through the server: a foreign page's request is refused before any route runs, and the app's own is not", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const foreign = await ask(port, "POST", "/v1/commands/disarm", { Origin: "http://127.0.0.1:5123" });
    assert.equal(foreign.status, 403);
    assert.match(foreign.body, /CROSS_SITE_REFUSED/);
    const embedded = await ask(port, "GET", "/v1/web/read?url=https://example.com/", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "image" });
    assert.equal(embedded.status, 403);
    const elsewhere = await ask(port, "GET", "/health", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "image" });
    assert.equal(elsewhere.status, 403);
    assert.equal((await ask(port, "GET", "/health", { Origin: "http://localhost:3210" })).status, 200);
    assert.equal((await ask(port, "GET", "/health", {})).status, 200);
    assert.notEqual((await ask(port, "OPTIONS", "/v1/assist", { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" })).status, 403, "a preflight is answered by cors()");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
