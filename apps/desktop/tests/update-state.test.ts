import test from "node:test";
import assert from "node:assert/strict";
import { encodedCommand, helperPowerShell, plainUpdateError, relaunchScript, updateSupport } from "../src/updateState.js";

// Which copies update themselves, and how a failure is said.

test("only the installed Windows app updates itself", () => {
  const installed = { isPackaged: true, platform: "win32", env: {} };
  assert.deepEqual(updateSupport(installed), { supported: true });
  assert.equal(updateSupport({ ...installed, isPackaged: false }).supported, false, "a copy run from source");
  const portable = updateSupport({ ...installed, env: { PORTABLE_EXECUTABLE_DIR: "C:\\Downloads" } });
  assert.equal(portable.supported, false);
  assert.match((portable as { reason: string }).reason, /portable/);
  assert.equal(updateSupport({ ...installed, platform: "linux" }).supported, false);
  assert.equal(updateSupport({ ...installed, env: { TRHAI_UPDATE_CHECK: "off" } }).supported, false);
});

test("failures are sentences, never stack traces", () => {
  assert.match(plainUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")), /could not be reached/);
  assert.match(plainUpdateError(new Error("getaddrinfo ENOTFOUND github.com")), /could not be reached/);
  assert.match(plainUpdateError(new Error("sha512 checksum mismatch, expected abc, got def")), /checksum/);
  assert.match(plainUpdateError(new Error("Cannot find latest.yml in the latest release artifacts (https://...): HttpError: 404")), /no installer/);
  assert.match(plainUpdateError(new Error("ENOSPC: no space left on device")), /disk space/);
  const other = plainUpdateError(new Error("something odd\n    at Object.<anonymous> (updater.js:1:1)"));
  assert.equal(other, "The update did not work: something odd");
  assert.equal(plainUpdateError(undefined), "The update did not work.");
});

test("after an update the helper waits for the app and the installer, then starts the app once", () => {
  const script = relaunchScript("C:\\Users\\O'Neil\\AppData\\Local\\Programs\\trh-ai\\TRH AI.exe", 4242);
  assert.ok(script.includes("$exe = 'C:\\Users\\O''Neil\\AppData\\Local\\Programs\\trh-ai\\TRH AI.exe'"), "a quote in the path is doubled");
  assert.match(script, /Wait-Process -Id 4242 /);
  assert.match(script, /ProcessName -like 'TRH-AI-Setup\*'/);
  assert.match(script, /Where-Object \{ \$_\.Path -eq \$exe \}\) \{ Note 'the app is already running'; exit \}/, "not started twice");
  assert.match(script, /if \(-not \(Test-Path -LiteralPath \$exe\)\) \{ Note 'the app is no longer installed'; exit \}/, "not started once uninstalled");
  assert.ok(script.indexOf("Wait-Process") < script.indexOf("TRH-AI-Setup") && script.indexOf("TRH-AI-Setup") < script.indexOf("Start-Process"), "app gone, installer done, then start");
  assert.match(relaunchScript("x", 12.9), /Wait-Process -Id 12 /);
  assert.match(script, /^function Note\(\$text\) \{\}/, "without a log path, notes go nowhere");
  const logged = relaunchScript("x", 1, { logPath: "C:\\Users\\O'Neil\\logs\\update-restart.log" });
  assert.ok(logged.includes("Add-Content -LiteralPath 'C:\\Users\\O''Neil\\logs\\update-restart.log'"));
});

test("the helper's script goes to PowerShell whole, encoded, line breaks and all", () => {
  const script = "Note 'one'\nNote 'two'";
  assert.equal(Buffer.from(encodedCommand(script), "base64").toString("utf16le"), script);
});

test("the helper's PowerShell asks nothing, loads nothing, shows nothing", () => {
  const args = helperPowerShell("QQBCAEMA");
  assert.equal(args[0], "powershell.exe");
  for (const flag of ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]) assert.ok(args.includes(flag), flag);
  assert.deepEqual(args.slice(-2), ["-EncodedCommand", "QQBCAEMA"]);
});
