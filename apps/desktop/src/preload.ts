import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ascendDesktop", {
  appName: "Vexora AI",
  version: "0.1.4",
  createWorkspaceScaffold: (payload: unknown) => ipcRenderer.invoke("ascend:create-scaffold", payload),
  getSystemTelemetry: () => ipcRenderer.invoke("ascend:get-system-telemetry"),
  listProjectInventory: () => ipcRenderer.invoke("ascend:list-project-inventory"),
  listStorageDevices: () => ipcRenderer.invoke("ascend:list-storage-devices"),
  openPath: (targetPath: string) => ipcRenderer.invoke("ascend:open-path", targetPath),
  runWorkspaceCommand: (payload: { command: string; cwd?: string }) => ipcRenderer.invoke("ascend:run-command", payload),
  onRuntimeEvent: (listener: (event: {
    runId: string;
    kind: "start" | "stdout" | "stderr" | "exit";
    line: string;
    level: "info" | "ok" | "warn" | "error";
    timestamp: number;
  }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: {
      runId: string;
      kind: "start" | "stdout" | "stderr" | "exit";
      line: string;
      level: "info" | "ok" | "warn" | "error";
      timestamp: number;
    }) => {
      listener(payload);
    };

    ipcRenderer.on("ascend:runtime-event", handler);
    return () => {
      ipcRenderer.removeListener("ascend:runtime-event", handler);
    };
  }
});
