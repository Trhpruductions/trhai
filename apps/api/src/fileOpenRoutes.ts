import type { Express } from "express";
import { isLoopback } from "./services/networkAccess.js";
import { openWorkspacePath, type FileAction } from "./services/openInSystem.js";

const traceId = "trace-local";
const isJson = (header: string | undefined) => header?.toLowerCase().startsWith("application/json") === true;

/**
 * Open a file in the workspace in the program it belongs to, or show it in its
 * folder. It happens on this PC's own screen, so it is asked for by this PC
 * only: another device that has been let in cannot make a document appear on
 * the screen of the machine it is connected to. And only as JSON, which a page
 * on another site cannot send without the browser asking this API first.
 * Not behind the paywall: opening a file the person already has is not work.
 */
export function registerFileOpenRoutes(app: Express, options: { isThisPc?: (address: string | null | undefined) => boolean } = {}): void {
  const isThisPc = options.isThisPc ?? isLoopback;
  app.post("/v1/files/open", async (req, res) => {
    if (!isJson(req.headers["content-type"])) {
      res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this as JSON.", traceId });
      return;
    }
    if (!isThisPc(req.socket.remoteAddress)) {
      res.status(403).json({ code: "FORBIDDEN", message: "Files open on this PC's screen, so they can only be opened from this PC.", traceId });
      return;
    }
    const given = req.body?.action;
    if (given !== undefined && given !== "open" && given !== "reveal") {
      res.status(400).json({ code: "INVALID_REQUEST", message: 'action must be "open" or "reveal".', traceId });
      return;
    }
    const action: FileAction = given === "reveal" ? "reveal" : "open";
    const target = req.body?.path;
    if (typeof target !== "string" || target.length === 0 || target.length > 1000) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "path is required: a file or folder in the workspace.", traceId });
      return;
    }
    const outcome = await openWorkspacePath(target, action);
    if (!outcome.ok) {
      const code = outcome.status === 404 ? "NOT_FOUND" : outcome.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : outcome.status === 500 ? "OPEN_FAILED" : "INVALID_REQUEST";
      res.status(outcome.status).json({ code, message: outcome.reason, traceId });
      return;
    }
    res.json({ data: { action, path: target }, traceId });
  });
}
