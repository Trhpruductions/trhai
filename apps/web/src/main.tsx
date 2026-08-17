import React from "react";
import { createRoot } from "react-dom/client";
import { Ascend } from "./ui/Ascend";
import { webEnv } from "./env";

console.info(`[${webEnv.appName}] ready`);

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <Ascend />
  </React.StrictMode>
);
