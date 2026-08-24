import { execFileSync } from "node:child_process";

// Same motivation as the API's buildInfo.ts, same shape of answer, kept as
// its own small file rather than shared: main.ts already computes
// workspaceRoot and the Electron-only facts (packaged state, app path) with
// its own path-resolution logic, and pulling those into a cross-package
// dependency for one three-line git wrapper is more machinery than the
// problem needs. This file has no Electron import, so it can be unit tested
// like launcher.ts and pathGuard.ts are — main.ts itself cannot be.

export type DesktopBuildInfo = {
  version: string;
  environment: "development" | "production";
  appPath: string;
  workspaceRoot: string;
  /** Set by Launch-Vexora.bat before it starts Electron; absent otherwise. */
  launchedVia: string;
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  gitCommitDate: string | null;
  gitDirty: boolean | null;
};

/** Null on any failure — no git binary, not a checkout, a shallow clone missing the ref. Never thrown. */
function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

export function getDesktopBuildInfo(params: {
  version: string;
  packaged: boolean;
  appPath: string;
  workspaceRoot: string;
  /** Injected for tests; defaults to the real environment. */
  launchedViaEnv?: string;
}): DesktopBuildInfo {
  const gitStatus = git(params.workspaceRoot, ["status", "--porcelain"]);
  const launchedVia = (params.launchedViaEnv ?? process.env.ASCEND_LAUNCHED_VIA)?.trim();

  return {
    version: params.version,
    environment: params.packaged ? "production" : "development",
    appPath: params.appPath,
    workspaceRoot: params.workspaceRoot,
    launchedVia: launchedVia || "unknown — not started from Launch-Vexora.bat",
    gitCommit: git(params.workspaceRoot, ["rev-parse", "HEAD"]),
    gitCommitShort: git(params.workspaceRoot, ["rev-parse", "--short", "HEAD"]),
    gitBranch: git(params.workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitCommitDate: git(params.workspaceRoot, ["log", "-1", "--format=%cI"]),
    gitDirty: gitStatus === null ? null : gitStatus.length > 0
  };
}
