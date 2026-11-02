import type { NextFunction, Request, Response } from "express";
import { isAllowedOrigin } from "./originPolicy.js";

// Which browser pages may make this service do anything.
//
// CORS (originPolicy.ts) decides whether a page may READ a reply. It never stops the
// request itself: a page on any site, or one of the apps TRH AI builds on another
// loopback port, can still fire a request here without reading the answer, and for
// a request that does something - arm machine access, start a download, send a test
// email through the saved account, fetch a page on the model's behalf - the answer
// is not the point. So, before anything else runs, a request that a browser marks
// as coming from another page is refused outright, whatever its method.
//
// Two marks are read. `Origin` is sent with every fetch, XHR and form post from a
// page, and must be the app's own origin. `Sec-Fetch-Site: cross-site` is sent with
// a subresource - an <img>, a <script> - placed on a page from another site, which
// carries no Origin. A request with neither mark (curl, the launcher, the desktop
// shell's own checks, a URL typed into the address bar) is a request from this PC,
// and passes. A preflight (OPTIONS) passes to cors(), which answers it.
//
// What this does not catch: a subresource placed on a page served from another
// port of this very PC, which a browser calls "same-site". For the two routes
// whose work is an outbound request, that is refused too, by its destination:
// a fetch or XHR says `Sec-Fetch-Dest: empty`, and an <img> or <script> does not.

export type OriginVerdict = { refused: false } | { refused: true; message: string };

type Marks = { origin?: string; secFetchSite?: string; secFetchDest?: string };

/** The routes whose work is a request to the outside world. */
const outboundRoutes = ["/v1/web/"];

export function crossSiteVerdict(marks: Marks, method: string, path: string, configuredOrigins?: string): OriginVerdict {
  if (method === "OPTIONS") return { refused: false };
  if (marks.origin !== undefined && marks.origin !== "null" && !isAllowedOrigin(marks.origin, configuredOrigins)) {
    return { refused: true, message: "This request came from a page that is not TRH AI, so it was not acted on." };
  }
  if (marks.origin === "null") {
    // A sandboxed frame, a file: page, or a redirect from another site: not the app.
    return { refused: true, message: "This request came from a page that is not TRH AI, so it was not acted on." };
  }
  if (marks.secFetchSite?.toLowerCase() === "cross-site") {
    return { refused: true, message: "This request was placed on a page from another site, so it was not acted on." };
  }
  const dest = marks.secFetchDest?.toLowerCase();
  if (dest !== undefined && dest !== "empty" && outboundRoutes.some((prefix) => path.startsWith(prefix))) {
    return { refused: true, message: "A page cannot make TRH AI fetch something by embedding this address; only the app's own requests may." };
  }
  return { refused: false };
}

/** The guard, as middleware. Sits before CORS, so a refused request is never answered at all. */
export function refuseCrossSite(configuredOrigins?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = crossSiteVerdict({
      origin: req.headers.origin,
      secFetchSite: req.get("sec-fetch-site"),
      secFetchDest: req.get("sec-fetch-dest")
    }, req.method, req.path, configuredOrigins);
    if (verdict.refused) {
      res.status(403).json({ code: "CROSS_SITE_REFUSED", message: verdict.message, traceId: "trace-local" });
      return;
    }
    next();
  };
}
