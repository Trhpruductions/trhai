import type { Express } from "express";
import { listMusicVideos, musicVideoReadiness, parseMusicVideoRequest, saveUpload, whyNotMusicVideo } from "./services/musicVideoFiles.js";
import { cancelMusicVideo, musicVideoStatus, startMusicVideo } from "./services/musicVideoJob.js";

const traceId = "trace-local";
const isJson = (header: string | undefined) => header?.toLowerCase().startsWith("application/json") === true;

/**
 * Music videos: a song in, a finished video out (see services/musicVideo.ts).
 *
 * Everything that changes something is refused unless it arrives as JSON, or as
 * the song itself with an audio type: a page on another site cannot send either
 * without the browser first asking this API's permission, so none of them can be
 * started by a page the user merely visited. The paywall covers the same routes
 * (server.ts): reading stays open, making a video does not.
 */
export function registerMusicVideoRoutes(app: Express): void {
  // How a video is getting on, and what this PC is ready to do. Cheap, and asked often.
  app.get("/v1/music-video", (_req, res) => {
    res.json({ data: { job: musicVideoStatus(), ready: musicVideoReadiness() }, traceId });
  });

  // The videos already made, with their lyrics, so that one can be made again with the lyrics changed.
  app.get("/v1/music-video/library", (_req, res) => {
    res.json({ data: { videos: listMusicVideos() }, traceId });
  });

  // The song, as the body of the request, written to the workspace as it arrives.
  app.post("/v1/music-video/audio", async (req, res) => {
    const type = (req.headers["content-type"] ?? "").toLowerCase();
    if (!type.startsWith("audio/") && !type.startsWith("application/octet-stream")) {
      res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send the song itself, as the body, with an audio content type.", traceId });
      return;
    }
    const length = Number(req.headers["content-length"]);
    const saved = await saveUpload(req, typeof req.query.name === "string" ? req.query.name : "song.mp3", Number.isFinite(length) ? length : undefined);
    if (!saved.ok) {
      res.status(saved.status).json({ code: saved.status === 413 ? "PAYLOAD_TOO_LARGE" : saved.status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST", message: saved.reason, traceId });
      return;
    }
    res.status(201).json({ data: { path: saved.path, bytes: saved.bytes }, traceId });
  });

  app.post("/v1/music-video", (req, res) => {
    if (!isJson(req.headers["content-type"])) {
      res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this as JSON.", traceId });
      return;
    }
    const parsed = parseMusicVideoRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ code: "INVALID_REQUEST", message: parsed.message, traceId });
      return;
    }
    const impossible = whyNotMusicVideo(parsed.request);
    if (impossible) {
      res.status(400).json({ code: "INVALID_REQUEST", message: impossible, traceId });
      return;
    }
    const started = startMusicVideo(parsed.request);
    if (!started.ok) {
      res.status(started.busy ? 409 : 400).json({ code: started.busy ? "BUSY" : "INVALID_REQUEST", message: started.reason, traceId });
      return;
    }
    res.status(202).json({ data: { id: started.id, job: musicVideoStatus() }, traceId });
  });

  app.post("/v1/music-video/cancel", (req, res) => {
    if (!isJson(req.headers["content-type"])) {
      res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Send this as JSON.", traceId });
      return;
    }
    res.json({ data: { cancelled: cancelMusicVideo(), job: musicVideoStatus() }, traceId });
  });
}
