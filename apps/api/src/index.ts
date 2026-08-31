import dotenv from "dotenv";
import { createApp } from "./server.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";

dotenv.config({ path: process.env.NODE_ENV === "test" ? ".env.test" : ".env" });

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
