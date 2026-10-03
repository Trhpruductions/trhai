// Preflight checks for a fresh machine (the `npm run doctor` command).
//
// Pure decision + formatting logic, kept out of the runner (scripts/doctor.ts)
// so it is unit-testable without touching the model engine, ffmpeg or the filesystem.
// Nothing here is fatal on its own: the app starts without a model, without
// ffmpeg and can create its workspace on first write. The point is to tell an
// operator setting the app up on another PC what is ready and what is not,
// before they wonder why a reply never comes.

export type CheckStatus = "ok" | "warn" | "missing";
export type SetupCheck = { name: string; status: CheckStatus; detail: string };

/**
 * Node major-version gate. Below `min` is a warning, not fatal - a mismatch may
 * still start but is the first thing to suspect when something behaves oddly.
 */
export function checkNodeVersion(version: string, min = 20): SetupCheck {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= min) {
    return { name: "Node.js", status: "ok", detail: `${version} (>= ${min} required)` };
  }
  return { name: "Node.js", status: "warn", detail: `${version} is below Node ${min}; upgrade Node.` };
}

/**
 * An optional external tool (ffmpeg and the like): present is fine, absent is a
 * warning that names the one feature it powers, so its absence never reads as a
 * broken install.
 */
export function checkOptionalTool(name: string, present: boolean, powers: string): SetupCheck {
  return present
    ? { name, status: "ok", detail: "found on PATH" }
    : { name, status: "warn", detail: `not found - ${powers} is unavailable until it is installed (everything else works)` };
}

/**
 * The model engine and its models, as they are on disk. Installed with at
 * least one model is ok; anything else is a warning that names the fix. Not
 * "missing", because the app genuinely runs without a model - it just cannot
 * generate.
 *
 * Read from disk rather than asked over HTTP: the engine runs only while TRH
 * AI does, and the doctor is for before it has ever been started.
 */
export function checkModelEngine(found: {
  /** The installed engine's release, or null when there is none. */
  build: string | null;
  engineDir: string;
  modelsDir: string;
  models: string[];
}): SetupCheck {
  const without = "The app runs without it, but cannot generate replies.";
  if (!found.build) {
    return { name: "Model engine", status: "warn", detail: `llama.cpp is not installed in ${found.engineDir}. Run: npm run setup:engine. ${without}` };
  }
  if (found.models.length === 0) {
    return {
      name: "Model engine", status: "warn",
      detail: `llama.cpp ${found.build} is installed, but there is no model in ${found.modelsDir}. Put a .gguf model file there. ${without}`
    };
  }
  return { name: "Model engine", status: "ok", detail: `llama.cpp ${found.build}, with ${found.models.join(", ")}` };
}

const mark: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", missing: "MISS" };

export function formatSetupReport(checks: SetupCheck[]): string {
  const body = checks.map((check) => `  [${mark[check.status]}] ${check.name}: ${check.detail}`).join("\n");
  const attention = checks.filter((check) => check.status !== "ok").length;
  const head = attention === 0
    ? "TRHAI setup check - all good."
    : `TRHAI setup check - ${attention} item(s) need attention:`;
  return `${head}\n${body}`;
}
