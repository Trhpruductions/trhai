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

/**
 * Whether an Origin header belongs to the app running on this machine.
 *
 * Any port is accepted: the web shell moves with ASCEND_WEB_PORT and the
 * desktop shell follows it, so pinning a port would break a supported setup for
 * no security gain — a hostile page cannot pick its own origin's hostname.
 *
 * The hostname is compared after parsing rather than by prefix. "http://
 * 127.0.0.1.evil.com" starts with the loopback address as text but is not
 * local, and a substring test would have admitted it.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return localHostnames.has(url.hostname);
  } catch {
    return false;
  }
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
