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
      runWorkspaceCommand?: (payload: {
        command: string;
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
