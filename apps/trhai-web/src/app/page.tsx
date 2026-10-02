"use client";

import { AppGate } from "../components/AppGate";
import { TrhaiOS } from "../os/TrhaiOS";

/**
 * The app: the loading screen and sign-in first, then TRH AI's operating
 * environment. See AppGate - nothing behind it mounts until the gate opens,
 * so every request it makes is already the signed-in account's.
 */
export default function Page() {
  return (
    <AppGate>
      <TrhaiOS />
    </AppGate>
  );
}
