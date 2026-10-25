// The ffmpeg command that draws a music video: a ring of spectrum bars that
// follows the song, over a dark gradient with drifting dust and a glow on the
// beat, with the title in the middle and the lyrics below.
//
// ffmpeg is given three things: a control video (the height of every bar and the
// glow level, one frame per video frame, made by audioAnalysis.ts and piped in),
// the song itself, and a few stills made by musicVideoLook.ts. Everything else it
// draws from the filter graph built here. The graph was settled by experiment;
// the points that cost the most to find out are marked where they apply.
//
// ffmpeg is run from inside the work folder, so the stills and the subtitle file
// are named without a path. A Windows path in a filter has a drive letter's colon
// and backslashes to escape, and getting that wrong fails in ways that vary
// with the build; no path, nothing to escape.

import { barsHigh, barsWide, controlBarRows, controlGlowRows, controlHeight, controlWidth, type Geometry, hex, type Palette } from "./musicVideoLook.js";

export const videoFps = 30;

/** The files the graph reads from the work folder. */
export const workFiles = {
  xmap: "xmap.png",
  ymap: "ymap.png",
  disc: "disc.png",
  dust: "dust.png",
  circle: "circle.png",
  coverSource: "cover-source.png",
  coverDisc: "cover-disc.png",
  coverBackground: "cover-bg.png",
  captions: "captions.ass"
} as const;

export type GraphOptions = {
  geometry: Geometry;
  palette: Palette;
  /** The hue turn for the sections, as an ffmpeg expression of t in seconds; "0" for none. */
  hue: string;
  /** Seconds. */
  duration: number;
  /** Whether cover-disc.png and cover-bg.png are in the work folder. */
  cover: boolean;
};

/** How long the picture takes to come up from black and to go out to it. */
export function fadeTimes(duration: number): { fadeIn: number; fadeOut: number; outAt: number } {
  const fadeIn = Math.min(1.2, duration / 4);
  const fadeOut = Math.min(2.5, duration / 3);
  return { fadeIn, fadeOut, outAt: Math.max(0, duration - fadeOut) };
}

/** The radius of the circle the cover is cut to, just inside where the bars start. */
export const coverRadius = (g: Geometry) => g.inner - Math.round(g.height / 90);

// The picture is built in planar RGB. Without a `format=gbrp` after every blend
// ffmpeg is free to pick a YUV format for it, and blending "screen" or "multiply"
// on the chroma planes casts the whole picture a colour. The graphProblems check
// below makes the rule a test failure, not something to remember.
const rgb = "format=gbrp";
const still = (file: string) => `movie=${file},${rgb},loop=-1:1:0,fps=${videoFps}`;

export function filterGraph(options: GraphOptions): string {
  const { geometry: g, palette: p } = options;
  const { width: W, height: H } = g;
  const top = g.centreY - g.outer;
  const bottom = g.centreY + g.outer;
  // How long the generated sources run for: a little beyond the song, since the output is cut at its length.
  const span = Math.ceil(options.duration) + 10;
  const { fadeIn, fadeOut, outAt } = fadeTimes(options.duration);
  const dustSpeed = Math.max(8, Math.round((H * 22) / 720));

  const chains: string[] = [
    "[0:v]split=2[ca][cb]",
    // The bars: one column of the control video each, widened to eight pixels with a gap between, then bent into a ring by the two maps.
    `[ca]crop=${controlWidth}:${controlBarRows}:0:0,scale=${barsWide}:${barsHigh}:flags=neighbor,format=gray,drawgrid=w=${barsWide / controlWidth}:h=0:t=2:c=black,format=gray16le[bars]`,
    `movie=${workFiles.xmap},format=gray16le,loop=-1:1:0,fps=${videoFps}[xm]`,
    `movie=${workFiles.ymap},format=gray16le,loop=-1:1:0,fps=${videoFps}[ym]`,
    `[bars][xm][ym]remap,${rgb}[radial]`,
    // Coloured from one end of the ring to the other (a fixed seed: without one, every run draws a different gradient).
    `gradients=s=${W}x${H}:c0=${hex(p.barsTop)}:c1=${hex(p.barsBottom)}:x0=0:y0=${top}:x1=0:y1=${bottom}:nb_colors=2:speed=0.01:rate=${videoFps}:d=${span}:seed=3,${rgb}[tint]`,
    `[radial][tint]blend=all_mode=multiply,${rgb},split[bars1][bars2]`,
    // A soft glow around the bars: the same picture, blurred and dimmed, added back.
    `[bars2]gblur=sigma=${Math.max(2, Math.round(H / 70))},${rgb},colorchannelmixer=rr=0.55:gg=0.55:bb=0.55,${rgb}[halo]`,
    `[bars1][halo]blend=all_mode=screen,${rgb}[ring]`,
    // The flash on the beat: the last rows of the control video, spread over the whole picture and tinted.
    `[cb]crop=${controlWidth}:${controlGlowRows}:0:${controlBarRows},scale=${W}:${H}:flags=fast_bilinear,${rgb},colorchannelmixer=rr=${p.glow[0]}:gg=${p.glow[1]}:bb=${p.glow[2]},${rgb}[flash]`,
    `gradients=s=${W}x${H}:c0=${hex(p.background[0])}:c1=${hex(p.background[1])}:c2=${hex(p.background[2])}:nb_colors=3:x0=0:y0=0:x1=${W}:y1=${H}:speed=0.008:rate=${videoFps}:d=${span}:seed=5,${rgb}[sky]`,
    `${still(workFiles.dust)},crop=${W}:${H}:0:'mod(t*${dustSpeed},${H})'[dust]`,
    `[sky][flash]blend=all_mode=screen,${rgb}[lit]`
  ];

  let background = "lit";
  if (options.cover) {
    chains.push(
      `${still(workFiles.coverBackground)}[tone]`,
      `[${background}][tone]blend=all_mode=screen,${rgb}[toned]`
    );
    background = "toned";
  }
  chains.push(
    `[${background}][dust]blend=all_mode=screen:all_opacity=0.5,${rgb}[dusty]`,
    `[dusty][ring]blend=all_mode=screen,${rgb}[scene]`,
    `${still(workFiles.disc)}[plate]`,
    `[scene][plate]blend=all_mode=multiply,${rgb}[plated]`
  );

  let scene = "plated";
  if (options.cover) {
    chains.push(
      `${still(workFiles.coverDisc)}[art]`,
      `[${scene}][art]blend=all_mode=screen,${rgb}[framed]`
    );
    scene = "framed";
  }

  // Back to YUV only at the end, for the hue turn, the vignette, the words and the encoder - and as ordinary video: limited range, BT.709.
  // Left to itself the conversion keeps RGB's full range and its identity matrix, and the file comes out tagged yuvj420p with a matrix
  // that players read as "this is really RGB".
  const finish = ["scale=in_range=pc:out_range=tv:out_color_matrix=bt709", "format=yuv420p"];
  if (options.hue !== "0") finish.push(`hue=h='${options.hue}'`);
  finish.push(
    "vignette=PI/4.2",
    `subtitles=${workFiles.captions}`,
    `fade=t=in:st=0:d=${fadeIn.toFixed(2)}`,
    `fade=t=out:st=${outAt.toFixed(2)}:d=${fadeOut.toFixed(2)}`,
    "format=yuv420p",
    // What the picture is, said in the picture itself: the encoder takes its tags from the frames.
    "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv"
  );
  chains.push(`[${scene}]${finish.join(",")}[v]`);
  return chains.join(";");
}

/** The full ffmpeg arguments: the control video arrives on stdin, the finished video goes to `output`, and progress is written to stdout. */
export function renderArgs(options: GraphOptions & { audio: string; output: string }): string[] {
  return [
    "-y", "-v", "error", "-nostats", "-progress", "pipe:1",
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${controlWidth}x${controlHeight}`, "-r", String(videoFps), "-i", "pipe:0",
    "-i", options.audio,
    "-filter_complex", filterGraph(options),
    "-map", "[v]", "-map", "1:a:0",
    // aq-mode 3 spends bits where the picture is dark, which most of this one is: without it the dark gradients show blocks.
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-x264-params", "aq-mode=3", "-pix_fmt", "yuv420p", "-r", String(videoFps),
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-t", options.duration.toFixed(3),
    options.output
  ];
}

/** Takes the song's cover art out of the file, if it has any: a still, written to the work folder. */
export function extractCoverArgs(audio: string): string[] {
  return ["-y", "-v", "error", "-i", audio, "-map", "0:v:0", "-frames:v", "1", workFiles.coverSource];
}

/**
 * Makes the two stills that show the cover: the cover cut to a circle, the size of
 * the picture and black outside it, and the cover blurred and dimmed to tint the
 * background. They are made once here, not in the main graph, where they would
 * be re-blended on every frame.
 */
export function coverArgs(g: Geometry): string[] {
  const radius = coverRadius(g);
  const size = radius * 2;
  const graph = [
    "[0:v]split=2[a][b]",
    `[a]scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size},${rgb},pad=${g.width}:${g.height}:${g.centreX - radius}:${g.centreY - radius}:black,${rgb}[placed]`,
    `movie=${workFiles.circle},${rgb}[cut]`,
    `[placed][cut]blend=all_mode=multiply,${rgb},format=rgb24[disc]`,
    `[b]scale=${g.width}:${g.height}:force_original_aspect_ratio=increase,crop=${g.width}:${g.height},gblur=sigma=${Math.round(g.height / 18)},${rgb},colorchannelmixer=rr=0.3:gg=0.3:bb=0.3,format=rgb24[tone]`
  ].join(";");
  return [
    "-y", "-v", "error", "-i", workFiles.coverSource, "-filter_complex", graph,
    "-map", "[disc]", "-frames:v", "1", workFiles.coverDisc,
    "-map", "[tone]", "-frames:v", "1", workFiles.coverBackground
  ];
}

// ---------------------------------------------------------------- the rules a graph must keep

/** Splits a chain at its commas, leaving alone those inside quotes or brackets, which belong to an expression. */
function filtersOf(chain: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of chain) {
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === "(") depth += 1;
    else if (!quoted && ch === ")") depth -= 1;
    if (ch === "," && !quoted && depth === 0) { out.push(current); current = ""; } else current += ch;
  }
  out.push(current);
  return out.map((filter) => filter.replace(/\[[^\]]*\]/g, "").trim());
}

/**
 * What is wrong with a graph, if anything: a blend not followed by a conversion
 * back to planar RGB, a label that is made and never used or used twice (ffmpeg
 * refuses a graph with a dangling output), or a file named with a path.
 */
export function graphProblems(graph: string, ends: { inputs?: string[]; outputs?: string[] } = {}): string[] {
  const inputs = new Set(ends.inputs ?? ["[0:v]"]);
  const outputs = new Set(ends.outputs ?? ["[v]"]);
  const problems: string[] = [];
  const chains = graph.split(";");
  for (const chain of chains) {
    const filters = filtersOf(chain);
    filters.forEach((filter, i) => {
      if (/^blend=/.test(filter) && filters[i + 1] !== rgb) problems.push(`a blend is followed by ${filters[i + 1] ?? "nothing"}, not ${rgb}: ${filter}`);
      const file = /^(?:movie|subtitles)=(.*)$/.exec(filter)?.[1];
      if (file && /[\\/:]/.test(file)) problems.push(`a file is named with a path: ${file}`);
    });
  }
  // A chain's labels at its start are what it takes in, and at its end what it gives out. split makes several at the end, a blend or remap takes several at the start.
  const made = new Map<string, number>();
  const used = new Map<string, number>();
  for (const chain of chains) {
    const first = /^((?:\[[^\]]+\])*)/.exec(chain)?.[1] ?? "";
    const last = /((?:\[[^\]]+\])*)$/.exec(chain)?.[1] ?? "";
    for (const label of first.match(/\[[^\]]+\]/g) ?? []) used.set(label, (used.get(label) ?? 0) + 1);
    for (const label of last.match(/\[[^\]]+\]/g) ?? []) made.set(label, (made.get(label) ?? 0) + 1);
  }
  for (const [label, count] of made) {
    if (count !== 1) problems.push(`${label} is made ${count} times`);
    if (!outputs.has(label) && used.get(label) !== 1) problems.push(`${label} is used ${used.get(label) ?? 0} times, not once`);
  }
  for (const [label, count] of used) {
    if (inputs.has(label)) {
      if (count !== 1) problems.push(`${label} is taken in ${count} times`);
    } else if (!made.has(label)) problems.push(`${label} is used ${count} times and never made`);
  }
  for (const label of outputs) if (!made.has(label)) problems.push(`${label} is never made`);
  for (const label of inputs) if (!used.has(label)) problems.push(`${label} is never used`);
  return problems;
}
