import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ascendDesktop", {
  appName: "Ascend AI Desktop",
  version: "0.1.4",
  createWorkspaceScaffold: (payload: unknown) => ipcRenderer.invoke("ascend:create-scaffold", payload),
  getSystemTelemetry: () => ipcRenderer.invoke("ascend:get-system-telemetry"),
  listProjectInventory: () => ipcRenderer.invoke("ascend:list-project-inventory"),
  listStorageDevices: () => ipcRenderer.invoke("ascend:list-storage-devices"),
  openPath: (targetPath: string) => ipcRenderer.invoke("ascend:open-path", targetPath)
});
