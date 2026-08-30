import { spawn } from "node:child_process";
import { resolveInWorkspace } from "./workspace.js";

// Verifying a build the assistant just wrote.
//
// build_app used to write files and report success on the strength of the
// write succeeding, never on the strength of the thing actually running.
// Every generated project ships its own smoke test with zero dependencies —
// see projectGenerator.ts's smokeFile — so there is no reason not to run it.
//
// The result is a report, not a boolean: "ran and failed" and "could not be
// run at all" are different situations and must not collapse into the same
// false. A verification step that quietly reports nothing on its own failure
// would recreate the exact problem this exists to close, one level up.

export type VerificationResult =
  | { ran: false; reason: string }
  | { ran: true; passed: boolean; output: string };

/** However long the generated server takes to boot and answer six requests. */
const verifyTimeoutMs = 20_000;

/**
 * Run a just-built project's own smoke test and report what happened.
 *
 * `folder` is resolved through the same containment check every other
 * workspace write goes through, rather than joined directly. build_app's own
 * `folder` always comes from slugify, which cannot itself produce "..", so
 * this was not reachable through that one caller — but this function does not
 * know who is calling it, and trusting a caller's incidental safety instead
 * of enforcing the invariant here is exactly the inconsistency the rest of
 * this codebase has been caught repeating.
 */
export async function verifyBuiltProject(
  folder: string,
  /** Overridable so a test can exercise the hang path without waiting for it. */
  timeoutMs = verifyTimeoutMs
): Promise<VerificationResult> {
  const projectDir = resolveInWorkspace(folder);
  if (!projectDir) {
    return { ran: false, reason: "that path is outside the workspace" };
  }

  // A port unlikely to collide with this app's own services (4000, 5173,
  // 11434/11435) or with a second verification running at the same moment.
  const port = 4300 + Math.floor(Math.random() * 500);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: VerificationResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ["smoke.js"], {
        cwd: projectDir,
        // PORT as well as SMOKE_PORT.
        //
        // The template's own smoke script reads SMOKE_PORT, but an app the
        // model wrote has never heard of it and reads PORT like any other Node
        // program. Setting only SMOKE_PORT left those checks on a hardcoded
        // 3000 — fine in isolation, and a collision with anything already
        // listening there, reported as the built app being broken.
        env: { ...process.env, SMOKE_PORT: String(port), PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ ran: false, reason: error instanceof Error ? error.message : "could not start the check" });
      return;
    }

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });

    // The smoke script starts its own server and is expected to exit on its
    // own; this bound exists only for the case where the generated server
    // hangs and never answers /health, so one bad build cannot stall the
    // agent loop indefinitely.
    const timer = setTimeout(() => {
      child.kill();
      finish({
        ran: false,
        reason: "the check did not finish within " + Math.round(timeoutMs / 1000) + "s"
      });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ran: false, reason: error.message });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      // smoke.js exits 0 only when every check passed; a non-zero code
      // (including a crash) is a failed build, not an inconclusive one, since
      // the script itself already ran to completion and said so.
      const summary = summarize(output);
      finish({ ran: true, passed: code === 0, output: summary });
    });
  });
}

/** The checks and their results, without the per-request noise. */
function summarize(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const checks = lines.filter((line) => line.startsWith("ok") || line.startsWith("FAIL"));
  if (checks.length === 0) return output.trim().slice(0, 400) || "no output";

  const passed = checks.filter((line) => line.startsWith("ok")).length;
  const failed = checks.filter((line) => line.startsWith("FAIL"));

  return failed.length === 0
    ? passed + "/" + checks.length + " checks passed"
    : passed + "/" + checks.length + " checks passed; failed: " + failed.join("; ");
}
