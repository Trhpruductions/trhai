"use client";

import { NotifyProvider } from "./state/notify";
import { NavProvider } from "./state/nav";
import { SystemProvider } from "./state/system";
import { AssistantProvider } from "./state/assistant";
import { AppShell } from "./shell/AppShell";
import "./os.css";
import "./shell/shell.css";
import "./legacy.css";

/**
 * TRH AI's operating environment: the shared state, then the shell.
 *
 * Mounted only once the sign-in gate opens (see AppGate), so every request it
 * makes already carries the signed-in account.
 */
export function TrhaiOS() {
  return (
    <NotifyProvider>
      <NavProvider>
        <SystemProvider>
          <AssistantProvider>
            <AppShell />
          </AssistantProvider>
        </SystemProvider>
      </NavProvider>
    </NotifyProvider>
  );
}
