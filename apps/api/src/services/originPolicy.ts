// Which origins may call this API from a browser.
//
// The API listens on localhost, which is not the protection it sounds like: a
// page on any site the user visits can issue requests to http://localhost:4000
// from their browser. CORS is what decides whether that page may *read* the
// reply, and the default was "*" — everyone.
//
// That matters here because the assist, memory and knowledge endpoints take no
// credentials at all. They are keyed by a session id the caller supplies, so a
// hostile page that learned or guessed one could read a user's saved memories
// and documents, or write to them.

/** Hostnames that are this machine. */
const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The web app's port: ASCEND_WEB_PORT, which the web app and the desktop shell also read, or 3210. */
export function webAppPort(env: NodeJS.ProcessEnv = process.env): string {
  return env.ASCEND_WEB_PORT?.trim() || "3210";
}

/**
 * Whether an Origin header belongs to the app running on this machine.
 *
 * This PC's addresses, on the web app's own port. It used to be any port, on
 * the reasoning that a hostile page cannot pick its own hostname - but this PC
 * also serves the apps TRH AI builds, each on a port of its own, and their code
 * is written by the model. Any of them could have read your memory and
 * documents from here. The port follows ASCEND_WEB_PORT, as the web app and the
 * desktop shell do, so moving it still works.
 *
 * The hostname is compared after parsing rather than by prefix. "http://
 * 127.0.0.1.evil.com" starts with the loopback address as text but is not
 * local, and a substring test would have admitted it.
 */
export function isLocalOrigin(origin: string, port: string = webAppPort()): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!localHostnames.has(url.hostname)) return false;
    return (url.port || (url.protocol === "https:" ? "443" : "80")) === port;
  } catch {
    return false;
  }
}

/**
 * Whether a request's Host header names this PC.
 *
 * CORS stops a hostile page reading replies from another origin, and DNS
 * rebinding walks around it: a site points its own name at 127.0.0.1 once the
 * page has loaded, and the page's requests to that name on port 4000 then
 * reach this API as the page's own origin, which CORS never checks. What gives
 * them away is the Host header, which still carries the site's name. So only
 * this PC's names are answered; with other devices let in (where the access
 * key guards everything from elsewhere), an address typed as numbers is too,
 * since no site can make a browser send its own origin under a bare address.
 */
export function isAllowedHost(hostHeader: string | undefined, options: { otherDevices?: boolean } = {}): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  const hostname = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
  if (localHostnames.has(hostname)) return true;
  if (options.otherDevices) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || /^[0-9a-f:]+$/.test(bare);
  }
  return false;
}

/**
 * Decide an origin against the policy.
 *
 * `undefined` means the request carried no Origin header — a curl, a server, or
 * the desktop shell loading from file:. Those are allowed because CORS does not
 * govern them: the browser only sends Origin when a page is making the request,
 * and refusing here would break every non-browser caller while stopping nothing.
 */
export function isAllowedOrigin(origin: string | undefined, configured?: string): boolean {
  if (origin === undefined) return true;

  if (configured && configured.trim()) {
    const allowed = configured.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (allowed.includes("*")) return true;
    return allowed.includes(origin);
  }

  return isLocalOrigin(origin);
}
