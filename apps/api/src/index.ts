import dotenv from "dotenv";
import { createApp } from "./server.js";
import { startScheduler } from "./services/scheduler.js";

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
