// Where the key art goes, so the live core on Home stands exactly on the art's
// own globe, at any window size.
//
// The art (public/trh-background.png) is a scene built around one object: a
// globe of light over a beam and a lit pedestal. The core is drawn as that
// globe (see CoreGL), so the two only read as one thing when they coincide -
// a few pixels out and the screen shows two globes. The numbers below were
// measured from the image by fitting a circle to the globe's bright edge, row
// by row; if the art is ever replaced, measure it again.

import { coreGlobeFraction } from "../../components/coreGeometry";

export { coreGlobeFraction };

export const keyArt = {
  src: "/trh-background.png",
  width: 1536,
  height: 1024,
  /** The globe's centre and radius, in the image's own pixels. */
  globeX: 770,
  globeY: 411,
  globeR: 128,
  /** The middle of the lit pedestal the beam lands on, straight below the globe. */
  pedestalY: 673
} as const;

export type Box = { left: number; top: number; width: number; height: number };

/** The art's top-left corner on screen, and how much it is scaled. */
export type Placement = { x: number; y: number; scale: number };

/** On the core: the art's globe centred on the core's, and the same size. */
export function placeOnCore(core: Box): Placement {
  const scale = (coreGlobeFraction * core.width) / keyArt.globeR;
  const centreX = core.left + core.width / 2;
  const centreY = core.top + core.height / 2;
  return { x: centreX - keyArt.globeX * scale, y: centreY - keyArt.globeY * scale, scale };
}

/**
 * Anywhere else: covering the whole window, with the globe over the middle of
 * the workspace column and a little above the window's middle - as near to
 * where Home puts it as covering allows, so moving between workspaces is a
 * small drift rather than a jump.
 */
export function placeCovering(viewport: { width: number; height: number }, column: { left: number; width: number }): Placement {
  // Large enough to cover the window, and to reach both of its sides from a
  // globe centred on the column - which the sidebar pushes right of the
  // window's middle, so the bare cover scale alone would leave a strip.
  const centre = column.left + column.width / 2;
  const scale = Math.max(
    viewport.width / keyArt.width,
    viewport.height / keyArt.height,
    centre / keyArt.globeX,
    (viewport.width - centre) / (keyArt.width - keyArt.globeX)
  );
  const width = keyArt.width * scale;
  const height = keyArt.height * scale;
  const wantX = centre - keyArt.globeX * scale;
  const wantY = viewport.height * 0.4 - keyArt.globeY * scale;
  return {
    x: Math.min(0, Math.max(viewport.width - width, wantX)),
    y: Math.min(0, Math.max(viewport.height - height, wantY)),
    scale
  };
}

/** Where a point of the art lands on screen. */
export function onScreen(placement: Placement, artX: number, artY: number): { x: number; y: number } {
  return { x: placement.x + artX * placement.scale, y: placement.y + artY * placement.scale };
}

/** Close enough that redrawing would change nothing visible. */
export function samePlacement(a: Placement | null, b: Placement, tolerance = 0.25): boolean {
  if (!a) return false;
  return Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance && Math.abs(a.scale - b.scale) < 0.0005;
}
