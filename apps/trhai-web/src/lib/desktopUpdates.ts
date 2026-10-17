// The installed app's own updater, as the window sees it: the desktop shell's
// bridge (apps/desktop/src/updater.ts), when there is one. In a browser, or a
// copy run from source, or the portable build, there is no updater to ask,
// and the screens offer the release's download link instead.

export type DesktopUpdateStatus =
  | { state: "unsupported"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available"; version: string | null }
  | { state: "downloading"; version: string; percent: number; bytesPerSecond: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type DesktopUpdater = {
  status: () => Promise<DesktopUpdateStatus>;
  check: () => Promise<DesktopUpdateStatus>;
  download: () => Promise<DesktopUpdateStatus>;
  install: () => Promise<DesktopUpdateStatus>;
  onStatus: (listener: (status: DesktopUpdateStatus) => void) => () => void;
};

/** The bridge, or null outside the installed desktop app. */
export function desktopUpdater(): DesktopUpdater | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { ascendDesktop?: { updates?: DesktopUpdater } }).ascendDesktop?.updates;
  return bridge && typeof bridge.download === "function" ? bridge : null;
}

export type UpdateAction =
  | { kind: "link" }
  | { kind: "download"; label: string; note: string | null }
  | { kind: "busy"; label: string }
  | { kind: "restart"; label: string };

/**
 * What the update button does, from the updater's state. Pure, so it is
 * tested without a window.
 */
export function updateAction(status: DesktopUpdateStatus | null, version: string): UpdateAction {
  if (!status || status.state === "unsupported") return { kind: "link" };
  switch (status.state) {
    case "checking": return { kind: "busy", label: "Checking…" };
    case "downloading": return { kind: "busy", label: `Downloading… ${Math.max(0, Math.min(100, status.percent))}%` };
    case "downloaded": return { kind: "restart", label: `Restart to update to v${status.version || version}` };
    case "error": return { kind: "download", label: "Try again", note: status.message };
    default: return { kind: "download", label: `Download and install v${version}`, note: null };
  }
}
