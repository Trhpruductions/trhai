// `npm run doctor` - a preflight for a fresh machine.
//
// Read-only: it starts nothing and changes nothing (bar a probe file it removes
// immediately). It answers one question - "is this PC set up to run TRHAI?" -
// and is most useful on a headless server where the on-screen SYSTEM panel is
// not in front of you. Exit code is 0 unless a check throws; warnings are
// informational, because the app runs (in a reduced form) through every one of
// them.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { readLocalModelConfig, checkAvailability } from "../apps/api/src/services/localModel.js";
import { workspaceRoot } from "../apps/api/src/services/workspace.js";
import {
  checkNodeVersion, checkOptionalTool, checkOllama, formatSetupReport, type SetupCheck
} from "../apps/api/src/services/setupDoctor.js";

async function main(): Promise<void> {
  const checks: SetupCheck[] = [];

  checks.push(checkNodeVersion(process.version));

  // The local model, via the app's own availability check (reachable + a usable
  // model pulled), so the doctor and the running app agree on what "ready" means.
  const config = readLocalModelConfig();
  const avail = await checkAvailability(config);
  checks.push(checkOllama(
    avail.available,
    avail.available ? `${config.baseUrl}, "${avail.model}" ready.` : avail.reason
  ));

  // ffmpeg powers make_video only; a fixed command, shell:true so Windows PATH
  // resolution finds ffmpeg.exe.
  const ffmpeg = spawnSync("ffmpeg -version", { stdio: "ignore", shell: true });
  checks.push(checkOptionalTool("ffmpeg", !ffmpeg.error && ffmpeg.status === 0, "make_video"));

  // The workspace is created on first write in normal use; prove it can be here.
  const root = workspaceRoot();
  try {
    mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".doctor-write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe);
    checks.push({ name: "Workspace", status: "ok", detail: `writable: ${root}` });
  } catch (error) {
    checks.push({ name: "Workspace", status: "warn", detail: `cannot write to ${root}: ${(error as Error).message}` });
  }

  console.log(formatSetupReport(checks));
}

main().catch((error) => {
  console.error("doctor failed to run:", error);
  process.exitCode = 1;
});
