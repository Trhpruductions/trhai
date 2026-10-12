// TRH World's own server: the page, and a read-only window onto TRH AI's API.
//
// Two jobs and nothing else. It serves the files in public/, and it passes
// GET /api/world to TRH AI's /v1/world so the page does not have to ask another
// origin for it (which the API's CORS rule would refuse, on purpose). Nothing
// else is forwarded, and it only ever listens on this PC's own address.
//
// No dependencies: it runs with `node server.mjs`.

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

/** What the page may ask for, and where it comes from. Anything else is a 404. */
const forwarded = new Map([
  ["/api/world", "/v1/world"],
  ["/api/health", "/health"]
]);

export function createServer({ upstream = process.env.TRHAI_API_URL ?? "http://127.0.0.1:4000" } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    const target = forwarded.get(url.pathname);
    if (target) {
      try {
        const answer = await fetch(upstream + target, { signal: AbortSignal.timeout(4000) });
        const body = Buffer.from(await answer.arrayBuffer());
        res.writeHead(answer.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body);
      } catch {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
          .end(JSON.stringify({ code: "TRHAI_NOT_RUNNING", message: "TRH AI is not answering." }));
      }
      return;
    }

    // A file in public/, and only there: the resolved path has to stay inside it.
    const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-cache"
      }).end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.WORLD_PORT ?? 3333);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`TRH World on http://127.0.0.1:${port}`);
  });
}
