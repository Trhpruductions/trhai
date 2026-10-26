// What the installed app's own updater is doing, in a shape the window can
// show, and the decisions that do not need Electron to make: whether this copy
// can update itself at all, and how a failure is said. Kept apart from
// updater.ts so the tests can load it without Electron.

export type DesktopUpdateStatus =
  | { state: "unsupported"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available"; version: string | null }
  | { state: "downloading"; version: string; percent: number; bytesPerSecond: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export type UpdateSupport = { supported: true } | { supported: false; reason: string };

/**
 * Only the installed app updates itself. A copy run from the source tree is
 * updated with git; the portable build is one file the person keeps wherever
 * they like, and has nowhere to install over, so it is pointed at the
 * download instead.
 */
export function updateSupport(input: { isPackaged: boolean; platform: string; env: Record<string, string | undefined> }): UpdateSupport {
  if (input.env.TRHAI_UPDATE_CHECK === "off") return { supported: false, reason: "Checking for updates is switched off (TRHAI_UPDATE_CHECK=off)." };
  if (!input.isPackaged) return { supported: false, reason: "This copy runs from its source code, so it is updated from there, not by installing." };
  if (input.env.PORTABLE_EXECUTABLE_DIR) return { supported: false, reason: "The portable build does not install updates; download the new one from the release page." };
  if (input.platform !== "win32") return { supported: false, reason: "Updates install themselves on Windows only." };
  return { supported: true };
}

/**
 * An updater failure in a sentence a person can act on; never a stack trace.
 *
 * Read from electron-updater's error code and the message's first line only.
 * Some of its errors go on to quote the whole GitHub release feed, every
 * release's notes included, and a word in those notes must not decide what
 * this says: with only a pre-release published, "with checksums" in its notes
 * once turned "no release yet" into a checksum failure.
 */
export function plainUpdateError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "";
  const first = text.split("\n")[0].trim();
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_|getaddrinfo/i.test(first)) {
    return "The release page could not be reached. Check the internet connection and try again.";
  }
  if (code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" || code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || /please ensure a production release exists|No published versions/i.test(first)) {
    return "No release has been published yet, so there is nothing to update to.";
  }
  if (code === "ERR_CHECKSUM_MISMATCH" || /checksum mismatch/i.test(first)) {
    return "The download did not match its checksum, so it was not installed. Try again.";
  }
  if (/\b404\b|Cannot find .*latest\.yml/i.test(first)) {
    return "This release has no installer for this PC yet. Download it from the release page instead.";
  }
  if (/ENOSPC|no space/i.test(first)) return "There is not enough free disk space for the update.";
  return first ? `The update did not work: ${first.slice(0, 200)}` : "The update did not work.";
}

/**
 * The script that brings the app back after an update installs.
 *
 * electron-updater asks the installer to start the app when it finishes
 * (--force-run). That has not always happened: tried with both the assisted
 * and the one-click installer, an update installed and nothing started; in
 * other runs the installer did start the app, through Explorer. So the app
 * also starts this, hidden and detached, just before it quits into the
 * installer. It waits for the app to exit, then for the installer to finish,
 * then starts the app - unless something already has, which is why both can
 * be in play at once. Quotes in the path are doubled for PowerShell's
 * single-quoted strings.
 */
export function relaunchScript(exePath: string, appPid: number, options: { logPath?: string; installerPattern?: string } = {}): string {
  const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const pattern = options.installerPattern ?? "TRH-AI-Setup*";
  // Each step is written down, so a restart that did not happen on someone's
  // PC says where it stopped.
  const log = options.logPath
    ? `function Note($text) { try { Add-Content -LiteralPath ${quoted(options.logPath)} -Value ((Get-Date).ToString('s') + ' ' + $text) } catch {} }`
    : "function Note($text) {}";
  return [
    log,
    `$exe = ${quoted(exePath)}`,
    `$deadline = (Get-Date).AddMinutes(15)`,
    `Note 'waiting for the app (pid ${Math.trunc(appPid)}) to close'`,
    `try { Wait-Process -Id ${Math.trunc(appPid)} -Timeout 120 -ErrorAction Stop } catch {}`,
    `Start-Sleep -Seconds 2`,
    `Note 'waiting for the installer to finish'`,
    `while ((Get-Date) -lt $deadline) {`,
    `  if (-not (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like ${quoted(pattern)} })) { break }`,
    `  Start-Sleep -Seconds 2`,
    `}`,
    `Start-Sleep -Seconds 2`,
    `if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { Note 'the app is already running'; exit }`,
    `if (-not (Test-Path -LiteralPath $exe)) { Note 'the app is no longer installed'; exit }`,
    `Note 'starting the app'`,
    `Start-Process -FilePath $exe`
  ].join("\n");
}

/**
 * A script as PowerShell's -EncodedCommand wants it: UTF-16LE, base64.
 * Passed through -Command instead, a script with line breaks ran only its
 * first line, and the restart helper silently did nothing.
 */
export function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** PowerShell's command line for the helper: no profile, no prompts, hidden, the script encoded. */
export function helperPowerShell(encoded: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded];
}

export type HelperLaunch = { file: string; args: string[] };

/**
 * The ways to start the helper, in the order to try them: the next is tried when
 * one cannot be started at all.
 *
 * `cmd /c start` first. It gives PowerShell a console of its own - minimised, and
 * PowerShell hides itself as it begins - and it is the way that ran on every PC
 * it was tried on. Windows' console host in headless mode was first, because it
 * shows nothing, but on a current build of Windows 11 it starts, returns at once
 * and never runs the script: found by watching an update install on an installed
 * copy, which left no restart log (the installer's own restart saved that run).
 * It stays as the second way, where it is known to work. PowerShell started
 * detached on its own has no console and exits before running a line.
 */
export function helperLaunches(powershell: string[]): HelperLaunch[] {
  return [
    { file: "cmd.exe", args: ["/d", "/c", "start", "\"\"", "/min", ...powershell] },
    { file: "conhost.exe", args: ["--headless", ...powershell] }
  ];
}
