import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { expandKnownFolder, knownFolderPath, type FolderLookup } from "../src/services/knownFolders.js";

const windows = (registry: Record<string, string | undefined>, env: NodeJS.ProcessEnv = { USERPROFILE: "C:\\Users\\Sam" }): FolderLookup => ({
  platform: "win32",
  home: "C:\\Users\\Sam",
  env,
  registry: (name) => registry[name] ?? null
});

test("a Desktop that Windows keeps in OneDrive is found there, not under the home folder", () => {
  const lookup = windows({ Desktop: "%USERPROFILE%\\OneDrive\\Desktop", Personal: "%USERPROFILE%\\OneDrive\\Documents", "{374DE290-123F-4565-9164-39C4925E467B}": "%USERPROFILE%\\Downloads" });
  assert.equal(knownFolderPath("desktop", lookup), "C:\\Users\\Sam\\OneDrive\\Desktop");
  assert.equal(knownFolderPath("documents", lookup), "C:\\Users\\Sam\\OneDrive\\Documents");
  assert.equal(knownFolderPath("downloads", lookup), "C:\\Users\\Sam\\Downloads");
});

test("a folder the registry says nothing about, or says something unusable about, is the plain one under home", () => {
  assert.equal(knownFolderPath("desktop", windows({})), path.join("C:\\Users\\Sam", "Desktop"));
  assert.equal(knownFolderPath("pictures", windows({ "My Pictures": "%NO_SUCH_VARIABLE%\\Pictures" })), path.join("C:\\Users\\Sam", "Pictures"));
  assert.equal(knownFolderPath("music", windows({ "My Music": "relative\\Music" })), path.join("C:\\Users\\Sam", "Music"));
});

test("elsewhere than Windows the registry is not asked", () => {
  let asked = 0;
  const lookup: FolderLookup = { platform: "linux", home: "/home/sam", env: {}, registry: () => { asked += 1; return "/wrong"; } };
  assert.equal(knownFolderPath("videos", lookup), path.join("/home/sam", "Videos"));
  assert.equal(asked, 0);
});

test("this computer's own Desktop is a full path", () => {
  assert.ok(path.isAbsolute(knownFolderPath("desktop")));
});

test("a folder named the way a person says it is found, with whatever is inside it", () => {
  const lookup = windows({ Desktop: "%USERPROFILE%\\OneDrive\\Desktop" });
  const desktop = "C:\\Users\\Sam\\OneDrive\\Desktop";
  assert.equal(expandKnownFolder("Desktop", lookup), desktop);
  assert.equal(expandKnownFolder("my desktop", lookup), desktop);
  assert.equal(expandKnownFolder("the Desktop folder", lookup), desktop);
  assert.equal(expandKnownFolder('"desktop"', lookup), desktop);
  assert.equal(expandKnownFolder("~/Desktop", lookup), desktop);
  assert.equal(expandKnownFolder("%USERPROFILE%\\Desktop", lookup), desktop);
  assert.equal(expandKnownFolder("Desktop/Invoices", lookup), path.join(desktop, "Invoices"));
  assert.equal(expandKnownFolder("Desktop\\Invoices\\2026", lookup), path.join(desktop, "Invoices", "2026"));
  assert.equal(expandKnownFolder("~/Downloads", lookup), path.join("C:\\Users\\Sam", "Downloads"));
  assert.equal(expandKnownFolder("Pictures/Holiday", lookup), path.join("C:\\Users\\Sam", "Pictures", "Holiday"));
  assert.equal(expandKnownFolder("~", lookup), "C:\\Users\\Sam");
  assert.equal(expandKnownFolder("%userprofile%", lookup), "C:\\Users\\Sam");
});

test("anything else is not a known folder, and a way out of one is never followed", () => {
  const lookup = windows({});
  for (const request of ["reports", "documents-old", "C:/Users/Sam/Desktop", "D:\\Work", "../Desktop", "Desktop/../secrets", "~/../other", "", "   "]) {
    assert.equal(expandKnownFolder(request, lookup), null, JSON.stringify(request));
  }
});
