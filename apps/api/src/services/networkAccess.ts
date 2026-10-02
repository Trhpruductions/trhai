import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { dataFile } from "./dataDirectory.js";
import { readProtectedJsonFile, sameSecret, writeProtectedJsonFile } from "./protectedJson.js";

// Who can reach TRH AI's service.
//
// It listened on every address. Nothing asks a caller who they are - a made-up
// session id is enough - and with machine access on, run_command runs without
// asking, so any device on the same Wi-Fi or Tailscale network could have told
// this PC what to run. Windows Firewall allowed Node.js on private and public
// networks alike, so nothing stood in the way.
//
// Now it listens on this PC's own addresses and nowhere else: 127.0.0.1 and
// ::1. Both, because "localhost" resolves to ::1 first here, and a client that
// tries ::1 against a server on 127.0.0.1 alone waits for Windows to give up on
// the refused connection - measured at 2.1 s a request from PowerShell, longer
// than the launcher's own 2 s readiness check - while the desktop window loads
// 127.0.0.1 by name.
//
// ASCEND_NETWORK_ACCESS=on lets other devices in again, and then every request
// from one has to carry the access key. This PC never needs it.

/** The header another device sends the access key in. */
export const accessKeyHeader = "X-TRHAI-Key";

export type ListenPlan = { hosts: string[]; otherDevices: boolean };

/** Whether ASCEND_NETWORK_ACCESS asks for other devices to be let in. */
export function otherDevicesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|true|yes)$/i.test((env.ASCEND_NETWORK_ACCESS ?? "").trim());
}

/** Where the service listens: this PC's own two addresses, or - when asked - every address. */
export function listenPlan(env: NodeJS.ProcessEnv = process.env): ListenPlan {
  return otherDevicesAllowed(env)
    ? { hosts: ["::"], otherDevices: true }
    : { hosts: ["127.0.0.1", "::1"], otherDevices: false };
}

/**
 * Whether a connection came from this PC itself. Read from the socket, never
 * from a header: X-Forwarded-For is whatever the caller chose to write.
 */
export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  const plain = address.toLowerCase().replace(/^::ffff:/, "");
  return plain === "::1" || /^127(\.\d{1,3}){3}$/.test(plain);
}

export type Listener = { server: Server; address: AddressInfo };

/** Whether a listen error means this PC has no such address, rather than that something is wrong. */
function noSuchAddress(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT";
}

function bind(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", listening);
      reject(error);
    };
    const listening = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, host);
  });
}

/**
 * Listen on each host, all on one port. Port 0 (the tests) is settled by the
 * first listener and the rest take the same one.
 *
 * An IPv6 address this PC does not have - ::1 with IPv6 switched off - is
 * skipped, and "::" falls back to 0.0.0.0, as Node's own default does. Any
 * other failure closes what was opened and throws: a port already taken on
 * ::1 alone would leave "localhost" answered by someone else's server.
 */
export async function listenOn(
  createServer: () => Server,
  port: number,
  hosts: string[]
): Promise<{ listeners: Listener[]; skipped: Array<{ host: string; reason: string }> }> {
  const listeners: Listener[] = [];
  const skipped: Array<{ host: string; reason: string }> = [];
  let chosen = port;

  const closeAll = () => Promise.all(listeners.map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))));

  for (const host of hosts) {
    let server = createServer();
    try {
      await bind(server, chosen, host);
    } catch (error) {
      if (host === "::" && noSuchAddress(error)) {
        server = createServer();
        try {
          await bind(server, chosen, "0.0.0.0");
        } catch (fallback) {
          await closeAll();
          throw fallback;
        }
      } else if (host.includes(":") && noSuchAddress(error)) {
        skipped.push({ host, reason: (error as NodeJS.ErrnoException).code ?? "unavailable" });
        continue;
      } else {
        await closeAll();
        throw error;
      }
    }
    const address = server.address() as AddressInfo;
    chosen = address.port;
    listeners.push({ server, address });
  }

  if (listeners.length === 0) throw new Error(`Could not listen on ${hosts.join(" or ")}.`);
  return { listeners, skipped };
}

function keyFile(): string {
  return process.env.ASCEND_NETWORK_KEY_FILE ?? dataFile("network-access.json");
}

/**
 * The key another device must send. Made the first time it is needed and kept
 * encrypted with the rest of TRH AI's data, so it stays the same across
 * restarts and a device set up once keeps working.
 */
export function accessKey(): string {
  const file = keyFile();
  if (existsSync(file)) {
    const stored = readProtectedJsonFile(file) as { key?: unknown } | null;
    if (typeof stored?.key === "string" && stored.key.length >= 32) return stored.key;
  }
  const key = randomBytes(24).toString("base64url");
  writeProtectedJsonFile(file, { key, createdAt: new Date().toISOString() });
  return key;
}

/**
 * With other devices let in: a request from one must carry the access key.
 * This PC's own requests - the app, the desktop window, the launcher - never
 * do. A key that could not be read (null) lets no other device in at all.
 */
export function guardOtherDevices(key: string | null): express.RequestHandler {
  return (req, res, next) => {
    if (isLoopback(req.socket.remoteAddress)) {
      next();
      return;
    }
    const given = req.get(accessKeyHeader);
    if (key && typeof given === "string" && sameSecret(given, key)) {
      next();
      return;
    }
    res.status(401).json({
      code: "ACCESS_KEY_REQUIRED",
      message: `A request from another device needs TRH AI's access key in the ${accessKeyHeader} header. It is shown on the PC running TRH AI, under Network.`,
      traceId: "trace-local"
    });
  };
}
