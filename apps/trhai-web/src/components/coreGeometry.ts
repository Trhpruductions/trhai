// The core's proportions, shared by the shader that draws it and by the page
// that lines the key art up behind it (os/shell/artPlacement.ts). Kept in a
// file of its own, free of React and CSS, so both - and the tests - can read it.

/** The globe's radius as a fraction of the core's canvas size. */
export const coreGlobeFraction = 0.275;
