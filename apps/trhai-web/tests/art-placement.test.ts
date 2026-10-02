import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { coreGlobeFraction, keyArt, onScreen, placeCovering, placeOnCore, samePlacement } from "../src/os/shell/artPlacement.js";

// The key art's globe has to land exactly under the live core on Home, or the
// screen shows two globes; everywhere else the art has to fill the window.

test("on Home the art's globe sits exactly on the core's, at the core's size", () => {
  for (const core of [
    { left: 773, top: 112, width: 610, height: 610 },
    { left: 586, top: 104, width: 430, height: 430 },
    { left: 1093, top: 160, width: 1240, height: 1240 }
  ]) {
    const placement = placeOnCore(core);
    const globe = onScreen(placement, keyArt.globeX, keyArt.globeY);
    assert.ok(Math.abs(globe.x - (core.left + core.width / 2)) < 1e-9);
    assert.ok(Math.abs(globe.y - (core.top + core.height / 2)) < 1e-9);
    assert.ok(Math.abs(keyArt.globeR * placement.scale - coreGlobeFraction * core.width) < 1e-9);
  }
});

test("elsewhere the art covers the whole window, at every size the app supports", () => {
  for (const [width, height, sidebar] of [[1366, 768, 236], [1440, 900, 236], [1920, 1080, 236], [2560, 1440, 236], [3840, 2160, 236], [1024, 768, 68], [390, 844, 0]]) {
    const placement = placeCovering({ width, height }, { left: sidebar, width: width - sidebar });
    assert.ok(placement.x <= 0 && placement.y <= 0, `${width}x${height} leaves the top or left bare`);
    assert.ok(placement.x + keyArt.width * placement.scale >= width, `${width}x${height} leaves the right bare`);
    assert.ok(placement.y + keyArt.height * placement.scale >= height, `${width}x${height} leaves the bottom bare`);
  }
});

test("elsewhere the globe stays over the workspace column, not behind the sidebar", () => {
  const placement = placeCovering({ width: 1920, height: 1080 }, { left: 236, width: 1684 });
  const globe = onScreen(placement, keyArt.globeX, keyArt.globeY);
  assert.ok(Math.abs(globe.x - (236 + 1684 / 2)) < 2, `globe at ${globe.x}`);
});

test("the core's shader draws its globe at the size the placement assumes", () => {
  // CoreGL builds its shader from the shared constant; this catches anyone
  // putting a literal radius back into it, which would quietly misalign the art.
  const shader = readFileSync(new URL("../src/components/CoreGL.tsx", import.meta.url), "utf8");
  assert.match(shader, /const float GLOBE = \$\{coreGlobeFraction/);
  assert.match(shader, /float R = GLOBE \*/);
});

test("a placement that has not moved is not redrawn", () => {
  const a = { x: 10, y: 20, scale: 1.2 };
  assert.equal(samePlacement(a, { x: 10.1, y: 19.9, scale: 1.2 }), true);
  assert.equal(samePlacement(a, { x: 12, y: 20, scale: 1.2 }), false);
  assert.equal(samePlacement(null, a), false);
});
