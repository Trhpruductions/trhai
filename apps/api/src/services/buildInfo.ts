import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What build is actually running, read from the one place that cannot lie
// about it: git itself, and the package.json files already shipping with the
// code. Found live: three different installed copies of this app existed on
// one machine at once, under the same name, at wildly different ages and
// architectures — and there was no way to tell which one a running window
// actually was without opening a file browser and comparing timestamps. A bug
// report against "VEXORA" was meaningless without this.

export type BuildInfo = {
  apiVersion: string;
  webVersion: string;
  desktopVersion: string;
  /** "development" unless NODE_ENV says otherwise; this app has no other deploy target yet. */
  environment: string;
  /** Full commit hash, or null when this is not a git checkout (a packaged build with no .git). */
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  /** ISO timestamp of the current commit, not of this request. */
  gitCommitDate: string | null;
  /** True when there are uncommitted changes; null when git status could not be read at all. */
  gitDirty: boolean | null;
  /** When this process itself started answering requests. */
  serverStartedAt: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** apps/api/src/services -> repo root. */
const repoRoot = path.resolve(__dirname, "../../../..");

function readVersion(relativePackageJsonPath: string): string {
  try {
    const raw = readFileSync(path.join(repoRoot, relativePackageJsonPath), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Null on any failure — no git binary, not a checkout, a shallow clone missing the ref. Never thrown. */
function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

const serverStartedAt = new Date().toISOString();

export function getBuildInfo(): BuildInfo {
  const gitStatus = git(["status", "--porcelain"]);

  return {
    apiVersion: readVersion("apps/api/package.json"),
    webVersion: readVersion("apps/web/package.json"),
    desktopVersion: readVersion("apps/desktop/package.json"),
    environment: process.env.NODE_ENV?.trim() || "development",
    gitCommit: git(["rev-parse", "HEAD"]),
    gitCommitShort: git(["rev-parse", "--short", "HEAD"]),
    gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    gitCommitDate: git(["log", "-1", "--format=%cI"]),
    gitDirty: gitStatus === null ? null : gitStatus.length > 0,
    serverStartedAt
  };
}
