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
 * The rebuilt UI is being brought up one surface at a time, so it is opt-in
 * until it covers everything the current one does. Switching the default early
 * would trade a cluttered app for an incomplete one, and the point of doing it
 * this way is that the app never stops working while it is replaced.
 *
 * `?ui=next` for the rebuild, `?ui=classic` to go back; the choice sticks.
 */
const uiStorageKey = "ascend.ui.v1";

function resolveShell(): "next" | "classic" {
  const requested = new URLSearchParams(window.location.search).get("ui");
  if (requested === "next" || requested === "classic") {
    window.localStorage.setItem(uiStorageKey, requested);
    return requested;
  }
  return window.localStorage.getItem(uiStorageKey) === "next" ? "next" : "classic";
}

const shell = resolveShell();

createRoot(rootElement).render(
  <React.StrictMode>
    {shell === "next" ? <Ascend /> : <App />}
  </React.StrictMode>
);
