/// <reference types="vite/client" />

declare global {
  interface Window {
    ascendDesktop?: {
      appName: string;
      version: string;
      createWorkspaceScaffold?: (payload: {
        request: string;
        spec: {
          kind: string;
          path: string;
          fileName: string;
          content: string;
        };
      }) => Promise<{
        ok?: boolean;
        created?: boolean;
        path?: string;
        message?: string;
        error?: string;
      }>;
      getBuildInfo?: () => Promise<{
        ok?: boolean;
        version?: string;
        environment?: "development" | "production";
        appPath?: string;
        workspaceRoot?: string;
        launchedVia?: string;
        gitCommit?: string | null;
        gitCommitShort?: string | null;
        gitBranch?: string | null;
        gitCommitDate?: string | null;
        gitDirty?: boolean | null;
        error?: string;
      }>;
      getSystemTelemetry?: () => Promise<{
        ok?: boolean;
        source?: string;
        timestamp?: number;
        cpuPercent?: number;
        memoryPercent?: number;
        storagePercent?: number;
        networkPercent?: number;
        networkType?: string;
        error?: string;
      }>;
      listProjectInventory?: () => Promise<{
        ok?: boolean;
        projects?: Array<{
          name: string;
          path: string;
          group: "workspace" | "app" | "package" | "generated";
        }>;
        error?: string;
      }>;
      listStorageDevices?: () => Promise<{
        ok?: boolean;
        devices?: Array<{
          name: string;
          mountPath: string;
          totalBytes: number;
          freeBytes: number;
          usedBytes: number;
          usedPercent: number;
        }>;
        error?: string;
      }>;
      openPath?: (targetPath: string) => Promise<{
        ok?: boolean;
        error?: string;
      }>;
      connectProject?: () => Promise<{
        ok?: boolean;
        canceled?: boolean;
        project?: { root: string; name: string; connectedAt: string };
        error?: string;
      }>;
      disconnectProject?: () => Promise<{ ok?: boolean; disconnected?: boolean }>;
      getConnectedProject?: () => Promise<{
        ok?: boolean;
        project?: { root: string; name: string; connectedAt: string } | null;
      }>;
      listProjectFiles?: (payload: { subdirectory?: string }) => Promise<{
        ok?: boolean;
        entries?: Array<{ path: string; bytes: number; directory: boolean }>;
        error?: string;
      }>;
      readProjectFile?: (payload: { path: string }) => Promise<{
        ok?: boolean;
        content?: string;
        truncated?: boolean;
        error?: string;
      }>;
      listWorkspaceChecks?: () => Promise<{
        ok?: boolean;
        checks?: Array<{ name: string; label: string }>;
      }>;
      runWorkspaceCheck?: (payload: {
        check: string;
        cwd?: string;
      }) => Promise<{
        ok?: boolean;
        runId?: string;
        exitCode?: number;
        error?: string;
      }>;
      onRuntimeEvent?: (listener: (event: {
        runId: string;
        kind: "start" | "stdout" | "stderr" | "exit";
        line: string;
        level: "info" | "ok" | "warn" | "error";
        timestamp: number;
      }) => void) => () => void;
    };
  }
}

export {};
