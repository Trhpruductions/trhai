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
