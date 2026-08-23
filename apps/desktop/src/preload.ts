import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ascendDesktop", {
  appName: "Vexora AI",
  version: "0.1.4",
  createWorkspaceScaffold: (payload: unknown) => ipcRenderer.invoke("ascend:create-scaffold", payload),
  getBuildInfo: () => ipcRenderer.invoke("ascend:get-build-info"),
  getSystemTelemetry: () => ipcRenderer.invoke("ascend:get-system-telemetry"),
  listProjectInventory: () => ipcRenderer.invoke("ascend:list-project-inventory"),
  listStorageDevices: () => ipcRenderer.invoke("ascend:list-storage-devices"),
  openPath: (targetPath: string) => ipcRenderer.invoke("ascend:open-path", targetPath),
  // Named checks only. There is deliberately no way to send a command string
  // from here: the executable and its arguments live in the main process, and
  // this bridge carries a name the main process looks up. Renamed from
  // runWorkspaceCommand so a stale caller still passing { command } fails
  // loudly at the type and at runtime, rather than silently sending a payload
  // the handler now ignores.
  listWorkspaceChecks: () => ipcRenderer.invoke("ascend:list-workspace-checks"),
  runWorkspaceCheck: (payload: { check: string; cwd?: string }) => ipcRenderer.invoke("ascend:run-check", payload),
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
