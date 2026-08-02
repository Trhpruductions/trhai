import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { runAssistantOrchestrator } from "./services/orchestrator.js";
import { attachAuthIdentity } from "./middleware/auth.js";
import { v1MemoryRouter } from "./routes/v1Memory.js";
import { v1Router } from "./routes/v1.js";

type AssistRouteMode = "general" | "coding" | "business" | "creator";

function normalizeAssistMode(mode: unknown): AssistRouteMode {
  if (mode === "code" || mode === "debug" || mode === "research" || mode === "plan" || mode === "coding") {
    return "coding";
  }
  if (mode === "business") return "business";
  if (mode === "creator") return "creator";
  return "general";
}

export function createApp() {
  const app = express();
  const storageBackend = (process.env.API_STORAGE_BACKEND ?? "memory").toLowerCase();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("tiny"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ascend-api" });
  });

  app.post("/v1/assist", async (req, res, next) => {
    try {
      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      if (!message) {
        res.status(400).json({
          code: "INVALID_REQUEST",
          message: "message is required",
          traceId: "trace-local"
        });
        return;
      }

      const mode = normalizeAssistMode(req.body?.mode);
      const result = await runAssistantOrchestrator({
        mode,
        userMessage: message
      });

      res.json({
        data: {
          assistantMessage: result.assistantMessage,
          model: result.model,
          mode
        },
        traceId: "trace-local"
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(attachAuthIdentity());

  app.use("/v1", storageBackend === "postgres" ? v1Router : v1MemoryRouter);

  app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = error.statusCode ?? 500;
    res.status(statusCode).json({
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      message: error.message,
      traceId: "trace-local"
    });
  });

  app.use((req, res) => {
    res.status(404).json({
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.path}`,
      traceId: "n/a"
    });
  });

  return app;
}
