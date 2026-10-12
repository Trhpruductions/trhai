// TRH World's window. Run by Electron (from the desktop app's install): it only
// opens the page the World server is serving, on this PC, and nothing else.
"use strict";

const { app, BrowserWindow, shell } = require("electron");

const url = process.env.WORLD_URL || "http://127.0.0.1:3333";

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 520,
    title: "TRH World", backgroundColor: "#0b1020", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadURL(url);
  // Anything that is not the World page opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => { void shell.openExternal(target); return { action: "deny" }; });
  win.webContents.on("will-navigate", (event, target) => { if (!target.startsWith(url)) { event.preventDefault(); void shell.openExternal(target); } });
});

app.on("window-all-closed", () => app.quit());
