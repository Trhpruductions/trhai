import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ascendDesktop", {
  appName: "Ascend AI Desktop",
  version: "0.1.4",
  createWorkspaceScaffold: (payload: unknown) => ipcRenderer.invoke("ascend:create-scaffold", payload)
});
