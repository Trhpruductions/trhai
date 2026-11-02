import type { Request } from "express";
import { accountForToken, bearerToken } from "./accounts.js";

// Whose data a request is about.
//
// Conversations, memories, documents, to-dos and task history are kept under a
// key: `user:<account id>` for a signed-in person, the anonymous session id the
// browser made up for everyone else. Kept apart from server.ts so the routes
// that deal with a person's data (privacy) resolve the key the very same way the
// routes that write it do.

const maxSessionIdLength = 100;

/** Client-supplied session ids are untrusted; reject anything unusable. */
export function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxSessionIdLength) {
    return null;
  }
  // `user:` is the signed-in namespace (resolveMemoryKey). Accepted raw, it let
  // a caller with no token name an account's key and read its memories,
  // conversations and to-dos; it is reached only through a sign-in.
  if (/^user:/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * The key memory is filed under.
 *
 * A signed-in user owns their memory, so it follows them to any browser. Signed
 * out, the anonymous session id still works - requiring an account just to try
 * the assistant would be worse than the problem it solves. The `user:` prefix
 * keeps the two namespaces from ever colliding.
 */
export function resolveMemoryKey(req: Pick<Request, "headers">, sessionId: string | null): string | null {
  const account = accountForToken(bearerToken(req.headers.authorization));
  if (account) return `user:${account.id}`;
  return sessionId;
}
