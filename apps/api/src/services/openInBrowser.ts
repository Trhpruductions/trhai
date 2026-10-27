// Opens a web address in the person's own browser: whichever one the system has as its default.
//
// The address goes to the system as one argument and never through a shell, so nothing in it - an
// ampersand, a quote, a percent sign - can be read as a command. Only http and https are accepted;
// a file: path, a javascript: address or another program's own scheme is refused here, whatever asked.
//
// Whether the browser really came up is not something a launcher can see. What it can say is that
// the system accepted the request, or why it did not.

import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";

export type OpenResult = { ok: true } | { ok: false; reason: string };

/** What starting the launcher gives back: enough to hear whether it started. */
type Launched = EventEmitter & { unref(): void };

export type OpenOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Starts a process; the real one when absent. Injected for tests, which must never open a browser. */
  startProcess?: (file: string, args: string[]) => Launched;
};

/** An http or https address with a host, and nothing in front of the host. */
export function isWebAddress(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The program and its arguments that hand an address to the system's browser. */
export function launchCommand(url: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === "win32") return { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { file: "open", args: [url] };
  return { file: "xdg-open", args: [url] };
}

function realStart(file: string, args: string[]): Launched {
  return spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
}

export function openInBrowser(url: string, options: OpenOptions = {}): Promise<OpenResult> {
  const env = options.env ?? process.env;
  // For the test suite and for anyone who wants it off: set before any test can reach a real browser.
  if (env.TRHAI_OPEN_BROWSER === "off") {
    return Promise.resolve({ ok: false, reason: "Opening the browser is switched off here (TRHAI_OPEN_BROWSER=off)." });
  }
  if (!isWebAddress(url)) return Promise.resolve({ ok: false, reason: "That is not a web address." });

  // The parsed address, not the text it came in: always percent-encoded, never a space or a quote in it.
  const { file, args } = launchCommand(new URL(url).href, options.platform ?? process.platform);
  const start = options.startProcess ?? realStart;
  return new Promise((resolve) => {
    let launched: Launched;
    try {
      launched = start(file, args);
    } catch (error) {
      resolve({ ok: false, reason: `the system would not start the browser (${error instanceof Error ? error.message : String(error)}).` });
      return;
    }
    launched.once("error", (error: Error) => resolve({ ok: false, reason: `the system would not start the browser (${error.message}).` }));
    launched.once("spawn", () => {
      launched.unref();
      resolve({ ok: true });
    });
  });
}
