import test from "node:test";
import assert from "node:assert/strict";
import { canShareScreen, screenNotShared, shareScreen } from "../src/lib/screenShare.js";

// The page's globals, stood in for: the desktop app's bridge on `window`, the
// browser's share prompt on `navigator`. Node has a navigator of its own
// without one, so it is swapped for the length of each test and put back.
async function withPage<T>(page: { bridge?: unknown; getDisplayMedia?: unknown }, run: () => Promise<T>): Promise<T> {
  const hadWindow = "window" in globalThis;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  (globalThis as { window?: unknown }).window = page.bridge ? { ascendDesktop: page.bridge } : {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: page.getDisplayMedia ? { mediaDevices: { getDisplayMedia: page.getDisplayMedia } } : {}
  });
  try {
    return await run();
  } finally {
    if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow;
    else delete (globalThis as { window?: unknown }).window;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
  }
}

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

test("inside the desktop app, every screen it captured is attached, main screen first", async () => {
  const shared = await withPage({
    bridge: {
      captureScreens: async () => ({
        ok: true,
        screens: [{ name: "screen 1 (main).jpg", data: jpegBase64 }, { name: "screen 2.jpg", data: jpegBase64 }]
      })
    }
  }, () => shareScreen());
  assert.equal(shared.ok, true);
  if (!shared.ok) return;
  assert.deepEqual(shared.shots.map((shot) => shot.name), ["screen 1 (main).jpg", "screen 2.jpg"]);
  assert.equal(shared.shots[0].data, jpegBase64, "sent exactly as captured");
  assert.equal(shared.shots[0].bytes, 6);
  assert.match(shared.shots[0].previewUrl, /^blob:/);
  for (const shot of shared.shots) URL.revokeObjectURL(shot.previewUrl);
});

test("a capture that fails says why, and nothing is attached", async () => {
  const failed = await withPage({ bridge: { captureScreens: async () => ({ ok: false, error: "no screen gave a picture" }) } }, () => shareScreen());
  assert.deepEqual(failed, { ok: false, reason: "The screen could not be captured: no screen gave a picture" });

  const threw = await withPage({ bridge: { captureScreens: async () => { throw new Error("bridge gone"); } } }, () => shareScreen());
  assert.equal(threw.ok, false);
});

test("in a browser, a share that is cancelled sends nothing and says how to try again", async () => {
  let asked = 0;
  const cancelled = await withPage({
    getDisplayMedia: async () => {
      asked += 1;
      throw new Error("NotAllowedError");
    }
  }, () => shareScreen());
  assert.equal(asked, 1, "the browser's own prompt was used");
  assert.deepEqual(cancelled, { ok: false, reason: screenNotShared });
});

test("a page that cannot share the screen says so rather than offering it", async () => {
  await withPage({}, async () => {
    assert.equal(canShareScreen(), false);
    const unable = await shareScreen();
    assert.equal(unable.ok, false);
    if (!unable.ok) assert.match(unable.reason, /can't share the screen.*VISION/);
  });
  await withPage({ getDisplayMedia: async () => { throw new Error("x"); } }, async () => {
    assert.equal(canShareScreen(), true);
  });
});
