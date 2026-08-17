export interface DetachedSpawnConfig {
  command: string;
  args: string[];
}

export function getDetachedSpawnConfig(command: string, args: string[]): DetachedSpawnConfig {
  const normalizedCommand = command.trim();

  if (process.platform === "win32") {
    const renderedCommand = [normalizedCommand, ...args]
      .map((segment) => {
        if (/^[A-Za-z0-9._:/\\-]+$/.test(segment)) {
          return segment;
        }

        return `"${segment.replace(/"/g, '\\"')}"`;
      })
      .join(" ");

    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", renderedCommand]
    };
  }

  return {
    command: normalizedCommand,
    args
  };
}

/**
 * How a background service is spawned, per platform.
 *
 * On Windows this must never set `detached`. Node turns that into
 * CREATE_NEW_CONSOLE, which takes precedence over `windowsHide` — so every
 * service started this way flashed up its own console window, three of them,
 * every time the app opened. Without it the child shares this process's
 * console, which for a packaged Electron app is no console at all, and
 * `windowsHide` covers the cmd.exe shim.
 *
 * Elsewhere detaching is what puts the child in its own process group, which
 * is how it is later signalled as a group.
 */
export interface ServiceSpawnOptions {
  detached: boolean;
  windowsHide: boolean;
  stdio: "ignore";
}

export function getServiceSpawnOptions(platform: string = process.platform): ServiceSpawnOptions {
  return {
    detached: platform !== "win32",
    // Set on every platform. It is a no-op off Windows, and leaving it
    // conditional invited someone to drop it from the branch that needs it.
    windowsHide: true,
    stdio: "ignore"
  };
}
