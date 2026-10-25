import type { Express } from "express";
import { readFileSync, statSync } from "node:fs";
import { extractDocumentText, isDocumentPath, maxDocumentBytes } from "./services/documentText.js";
import { resolveInWorkspace } from "./services/workspace.js";

const traceId = "trace-local";

/** The most text of a document sent for a preview; the rest is there to be asked about. */
export const previewCharacters = 200_000;

/**
 * The words in a PDF, Word or PowerPoint file in the workspace, for the Files
 * screen to show where it cannot draw the file itself. Read with the same
 * reader the assistant uses on documents it is given, so what is shown is what
 * it would see. Same guard as every other path: only inside the workspace.
 */
export function registerDocumentPreviewRoutes(app: Express): void {
  app.get("/v1/files/document", async (req, res) => {
    const requested = typeof req.query.path === "string" ? req.query.path : "";
    const absolute = resolveInWorkspace(requested);
    if (!absolute) {
      res.status(400).json({ code: "INVALID_REQUEST", message: "That is not a place in the workspace.", traceId });
      return;
    }
    if (!isDocumentPath(absolute)) {
      res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Only PDF, Word and PowerPoint files are read this way.", traceId });
      return;
    }
    let size: number;
    try {
      const info = statSync(absolute);
      if (!info.isFile()) throw new Error("not a file");
      size = info.size;
    } catch {
      res.status(404).json({ code: "NOT_FOUND", message: "There is no file there.", traceId });
      return;
    }
    if (size > maxDocumentBytes) {
      res.status(413).json({ code: "PAYLOAD_TOO_LARGE", message: `That file is ${Math.round(size / 1024 / 1024)} MB; documents up to ${maxDocumentBytes / 1024 / 1024} MB can be read.`, traceId });
      return;
    }
    const read = await extractDocumentText(readFileSync(absolute), absolute);
    if (!read.ok) {
      res.status(422).json({ code: "UNREADABLE", message: read.reason, traceId });
      return;
    }
    res.json({
      data: {
        path: requested,
        kind: read.kind,
        ...(read.pages !== undefined ? { pages: read.pages } : {}),
        text: read.text.slice(0, previewCharacters),
        truncated: read.text.length > previewCharacters,
        characters: read.text.length
      },
      traceId
    });
  });
}
