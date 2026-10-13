// Serves the built app - `npm run start` - on this PC's own addresses only.
//
// `next start` listens on every address unless given one, so any device on the
// same network could load the app; and it takes only one. 127.0.0.1 alone
// leaves "localhost", which resolves to ::1 first here, waiting for Windows to
// give up on a refused connection - measured at 2.1 s a request from
// PowerShell, longer than the launcher's 2 s readiness check - and ::1 alone
// loses the desktop window, which loads 127.0.0.1. So this is Next's own
// request handler, the documented custom server, listening on both.
//
// It takes -p and -H as `next start` does, so the launcher and the desktop
// shell start it unchanged. A hostname naming this PC still means both of its
// addresses; any other is used as given.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listenHosts, serveOptions } from "./serve-options.mjs";

// Before Next is loaded: it picks its production code paths, and React's, by
// this. `next start` sets it the same way.
process.env.NODE_ENV = "production";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Inside a standalone build (the installer's copy) there is no next.config and
// no webpack: Next's generated server.js hands the resolved config over in
// this variable, and Next skips loading both when it is set. Running beside
// that server.js, this does the same with the config it carries.
if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  const standaloneConfig = readStandaloneConfig(path.join(dir, "server.js"));
  if (standaloneConfig) process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = standaloneConfig;
}

const { default: next } = await import("next");

/** The JSON Next wrote as `const nextConfig = {...}` in a standalone server.js, or undefined. */
function readStandaloneConfig(serverFile) {
  let source;
  try {
    source = readFileSync(serverFile, "utf8");
  } catch {
    return undefined;
  }
  const match = /^const nextConfig = (\{.*\})\s*$/m.exec(source);
  if (!match) return undefined;
  try {
    JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  return match[1];
}
const options = serveOptions(process.argv.slice(2), process.env);
const app = next({ dev: false, dir, hostname: "localhost", port: options.port });
const handle = app.getRequestHandler();
await app.prepare();

/** @param {import("node:http").Server} server @param {number} port @param {string} host */
function bind(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(undefined);
    });
  });
}

const servers = [];
let port = options.port;
for (const host of listenHosts(options.hostname)) {
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("Internal Server Error");
      }
    });
  });
  try {
    await bind(server, port, host);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    // ::1 on a PC with IPv6 switched off: 127.0.0.1 still serves.
    if (host === "::1" && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT")) continue;
    console.error(`trhai-web could not listen on ${host}, port ${port}: ${code ?? error}`);
    process.exit(1);
  }
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  port = address.port;
  servers.push({ server, address });
}

const where = servers.map(({ address }) => (address.family === "IPv6" ? `[${address.address}]` : address.address)).join(" and ");
console.log(`trhai-web ready on ${where}, port ${port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const { server } of servers) server.close();
    process.exit(0);
  });
}
