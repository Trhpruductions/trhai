import dotenv from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";

/**
 * Find .env by walking up from this file, not from the working directory.
 *
 * `dotenv.config({ path: ".env" })` resolves that relative path against
 * process.cwd(). The file lives at the repo root; npm runs a workspace script
 * with cwd set to the workspace, so `npm start` ran the API from apps/api and
 * loaded nothing at all. dotenv said so on every boot - "injected env (0) from
 * .env" - and (0) is the whole story.
 *
 * Seven settings were being ignored in normal operation: NODE_ENV, PORT,
 * CORS_ORIGIN, VITE_API_BASE_URL, DESKTOP_START_URL, API_STORAGE_BACKEND and
 * OLLAMA_MODEL. The visible symptom was the model: .env pins
 * qwen2.5-coder:7b, that is installed, and the app was answering on
 * vexora:latest - a 1.9GB model instead of the 4.7GB one that was asked for,
 * because with OLLAMA_MODEL unset pickModel falls through to the preference
 * list. Bad output that looked like a bad model was a bad config load.
 *
 * Walking up from import.meta.url is stable wherever the process is started:
 * the file's position relative to the repo root does not change, and the
 * working directory does.
 */
function findEnvFile(name: string): string | undefined {
  let directory = path.dirname(fileURLToPath(import.meta.url));

  // apps/api/src -> apps/api -> apps -> repo root is three; a few more in hand
  // costs nothing and survives the file moving one level.
  for (let hops = 0; hops < 6; hops += 1) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return undefined;
}

const envFile = findEnvFile(process.env.NODE_ENV === "test" ? ".env.test" : ".env");
if (envFile) dotenv.config({ path: envFile });

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`ascend-api listening on port ${port}`);
  // Started here rather than in createApp(): the test suite builds an app on
  // almost every file, and a live scheduler there would fire real assistant
  // requests at the local model during a test run. SCHEDULER=off disables it
  // for anyone who wants the API without the timers.
  if (process.env.SCHEDULER !== "off") startScheduler();
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  throw error;
});

// Shut down on purpose rather than by being killed.
//
// stopScheduler() existed and nothing ever called it, and there was no signal
// handling at all: Ctrl+C dropped whatever requests were in flight and killed
// any scheduled run at whatever line it had reached. claimRun() means a run
// interrupted that way is not replayed on restart, which is the right safety
// net - but relying on the safety net for the ordinary case of stopping the
// app is not the same as stopping cleanly.
//
// Windows force-kills (Stop-Process -Force, and what the desktop shell does to
// its own children) cannot be caught by anything, so this does not cover every
// exit. It covers the one a person actually performs.
let shuttingDown = false;

function shutdown(signal: string): void {
  // Two Ctrl+Cs should not run this twice; the second is usually someone
  // deciding the first did not work, so it exits immediately instead.
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;

  stopScheduler();
  server.close(() => {
    console.log(`ascend-api stopped (${signal})`);
    process.exit(0);
  });

  // A request that never finishes must not hold the process open forever.
  const forced = setTimeout(() => {
    console.error("ascend-api forced exit: connections still open after 5s");
    process.exit(1);
  }, 5000);
  // Do not let this timer itself be the reason the process stays alive.
  forced.unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}
