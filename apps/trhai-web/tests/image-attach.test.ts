import test from "node:test";
import assert from "node:assert/strict";
import { maxImageFileBytes, maxSide, refuseImage, scaledSize } from "../src/lib/imageAttach.js";

test("a large image is sent at most maxSide on its long side, proportions kept", () => {
  assert.deepEqual(scaledSize(3840, 2160), { width: 1920, height: 1080, scaled: true });
  assert.deepEqual(scaledSize(1080, 2400), { width: 864, height: maxSide, scaled: true }, "a tall phone screenshot");
  assert.deepEqual(scaledSize(1280, 720), { width: 1280, height: 720, scaled: false }, "small enough already");
  assert.deepEqual(scaledSize(0, 0), { width: 0, height: 0, scaled: false });
});

test("only images the vision model reads are attached", () => {
  assert.equal(refuseImage({ name: "shot.png", type: "image/png", size: 1000 }), null);
  assert.equal(refuseImage({ name: "photo.jpg", type: "image/jpeg", size: 1000 }), null);
  assert.match(refuseImage({ name: "icon.svg", type: "image/svg+xml", size: 1000 }) ?? "", /not an image TRH AI can look at/);
  assert.match(refuseImage({ name: "notes.txt", type: "text/plain", size: 10 }) ?? "", /not an image/);
  assert.match(refuseImage({ name: "empty.png", type: "image/png", size: 0 }) ?? "", /empty/);
  assert.match(refuseImage({ name: "huge.png", type: "image/png", size: maxImageFileBytes + 1 }) ?? "", /larger than 20 MB/);
});
