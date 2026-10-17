// fetch, for the model engine, without the five-minute limit.
//
// Node's built-in fetch gives up on any response that has not begun within
// 300 s (undici's headersTimeout), and nothing passed to fetch() changes it.
// The engine sends nothing until it has read the whole prompt, and on a PC
// without a graphics card that is slow: measured on an i5-3570, a 3,784-token
// prompt took 434 s at 8.7 tokens a second. Every such reply failed at five
// minutes as "the request failed", however long TRHAI_MODEL_TIMEOUT_MS
// allowed - the model was still working, and finished, for nobody.
//
// So engine requests go through Node's own http module, which has no such
// limit, and how long to wait stays where it always was: the caller's
// AbortSignal (requestDeadline, the user's Stop). It answers with a standard
// Response, streamed as it arrives, so every caller reads it as before.
//
// One connection per request, closed after it. Node's default agent keeps
// connections open to reuse them, and the engine closes its side after each
// answer: the request after a tool call - the model's second turn - went out
// on a dead connection and failed at once with "socket hang up". On this PC a
// new connection costs well under a millisecond against minutes of model time.
//
// The engine is on this PC, over plain http: nothing else needs this.

import http, { type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { engineKey } from "./engineKey.js";

const oneConnectionEach = new http.Agent({ keepAlive: false });

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

export function engineFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.protocol !== "http:") return fetch(input, init);
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return Promise.reject(abortError(signal));

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : null;
  if (body === null) return fetch(input, init);
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  headers.connection = "close";
  // The engine refuses requests without its key (engineKey.ts).
  const key = engineKey();
  if (key && !headers.authorization) headers.authorization = `Bearer ${key}`;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let answer: IncomingMessage | null = null;
    const request = http.request(url, { method: init.method ?? "GET", headers, agent: oneConnectionEach }, (incoming) => {
      settled = true;
      answer = incoming;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = incoming.statusCode ?? 502;
      const empty = status === 204 || status === 304 || (init.method ?? "GET").toUpperCase() === "HEAD";
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>), {
        status, statusText: incoming.statusMessage ?? "", headers: responseHeaders
      }));
    });

    const onAbort = () => {
      // Before the answer began, the promise rejects; after, the body stream
      // errors - with the abort itself, as fetch's does, not the socket's
      // "aborted": callers tell a time limit from a broken engine by its name.
      const reason = abortError(signal);
      (answer as IncomingMessage | null)?.destroy(reason);
      request.destroy(reason);
      if (!settled) reject(reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("close", () => signal?.removeEventListener("abort", onAbort));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(signal?.aborted ? abortError(signal) : new TypeError("fetch failed", { cause: error }));
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}
