import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Ascend } from "./ui/Ascend";
import { webEnv } from "./env";
import "./styles.css";

console.info(`[${webEnv.appName}] ready`);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

/**
 * Which shell to render.
 *
 * The rebuilt UI is the default. The previous one is kept behind ?ui=classic
 * for a short while: it is the only place the draggable widget board still
 * exists, and having a way back is cheap insurance while the new screens meet
 * real use for the first time.
 */
const uiStorageKey = "ascend.ui.v1";

function resolveShell(): "next" | "classic" {
  const requested = new URLSearchParams(window.location.search).get("ui");
  if (requested === "next" || requested === "classic") {
    window.localStorage.setItem(uiStorageKey, requested);
    return requested;
  }
  return window.localStorage.getItem(uiStorageKey) === "classic" ? "classic" : "next";
}

const shell = resolveShell();

createRoot(rootElement).render(
  <React.StrictMode>
    {shell === "next" ? <Ascend /> : <App />}
  </React.StrictMode>
);
