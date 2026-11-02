import type { IncomingMessage } from "node:http";

// What the access log says about a request.
//
// The log is a plain text file that is appended to and, until it was bounded, kept
// for good. A request's address can carry more than where it went: the anonymous
// session id that stands in for a password for a guest's data, the words of a web
// search, the address of a page, the path of a file, the name of an upload. None of
// that belongs in a file nobody is looking after. The log keeps the route and what
// became of the request - enough to see what the service was asked and how it
// answered - and never the query.

/** The route a request was made to, without its query string. */
export function pathOnly(req: Pick<IncomingMessage, "url"> & { originalUrl?: string }): string {
  const url = req.originalUrl ?? req.url ?? "";
  const mark = url.indexOf("?");
  return mark === -1 ? url : url.slice(0, mark);
}

/** morgan's "tiny" format with the route in place of the whole address. */
export const accessLogFormat = ":method :path :status :res[content-length] - :response-time ms";
