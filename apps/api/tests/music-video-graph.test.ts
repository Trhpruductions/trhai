import test from "node:test";
import assert from "node:assert/strict";
import { coverArgs, coverRadius, extractCoverArgs, fadeTimes, filterGraph, graphProblems, renderArgs, videoFps, workFiles } from "../src/services/musicVideoGraph.js";
import { controlHeight, geometryFor, hex, hueExpression, palettes } from "../src/services/musicVideoLook.js";

const base = { geometry: geometryFor(720), palette: palettes[0], hue: "0", duration: 60, cover: false };
const section = [{ start: 0, kind: "low" }, { start: 20, kind: "high" }, { start: 40, kind: "low" }];

test("the graph keeps to the rules, in every form it can take", () => {
  for (const height of [720, 1080] as const) {
    for (const cover of [false, true]) {
      for (const hue of ["0", hueExpression(section)]) {
        for (const palette of palettes) {
          const graph = filterGraph({ geometry: geometryFor(height), palette, hue, duration: 187.4, cover });
          assert.deepEqual(graphProblems(graph), [], `${height}p, cover ${cover}, hue ${hue}, ${palette.id}`);
        }
      }
    }
  }
});

test("the checker finds what it is there to find", () => {
  assert.deepEqual(graphProblems("[0:v]split=2[a][b];[a][b]blend=all_mode=screen,format=gbrp,format=yuv420p[v]"), []);
  assert.match(graphProblems("[0:v]split=2[a][b];[a][b]blend=all_mode=screen,format=yuv420p[v]").join("|"), /a blend is followed by format=yuv420p, not format=gbrp/);
  assert.match(graphProblems("[0:v]split=2[a][b];[a][b]blend=all_mode=screen[v]").join("|"), /followed by nothing/);
  assert.match(graphProblems("[0:v]split=2[a][b];[a]null[c];[c][b]blend=all_mode=screen,format=gbrp[v];[0:v]null[z]").join("|"), /taken in 2 times|\[z\] is used 0 times/);
  assert.match(graphProblems("[0:v]split=2[a][b];[a]null[v]").join("|"), /\[b\] is used 0 times, not once/);
  assert.match(graphProblems("[0:v]split=2[a][b];[a][b][b]hstack=inputs=3[v]").join("|"), /\[b\] is used 2 times, not once/);
  assert.match(graphProblems("[0:v]null[a];[a][missing]hstack[v]").join("|"), /\[missing\] is used 1 times and never made/);
  assert.match(graphProblems("[0:v]null[a];[a]null[w]").join("|"), /\[v\] is never made/);
  assert.match(graphProblems("movie=C:foo.png,format=gbrp[x];[0:v][x]hstack[v]").join("|"), /named with a path/);
  assert.match(graphProblems("movie=sub/foo.png[x];[0:v][x]hstack[v]").join("|"), /named with a path/);
  assert.match(graphProblems("[0:v]subtitles=D:/a.ass[v]").join("|"), /named with a path/);
  // A comma inside an expression is not the end of a filter.
  assert.deepEqual(graphProblems("[0:v]crop=10:10:0:'mod(t*2,10)'[a];[a]hue=h='clip(t,0,1)*3'[v]"), []);
  assert.deepEqual(graphProblems("[0:v]null[a];[a]null[w]", { outputs: ["[w]"] }), []);
});

test("the picture is the size asked for, with the palette's colours", () => {
  const graph = filterGraph({ ...base, geometry: geometryFor(1080), palette: palettes[1] });
  assert.ok(graph.includes("gradients=s=1920x1080:c0=" + hex(palettes[1].barsTop) + ":c1=" + hex(palettes[1].barsBottom)), "the bars' colours");
  assert.ok(graph.includes("c0=" + hex(palettes[1].background[0]) + ":c1=" + hex(palettes[1].background[1]) + ":c2=" + hex(palettes[1].background[2])), "the sky's colours");
  assert.ok(graph.includes("colorchannelmixer=rr=" + palettes[1].glow[0] + ":gg=" + palettes[1].glow[1] + ":bb=" + palettes[1].glow[2]), "the flash is tinted");
  assert.ok(graph.includes("seed=3") && graph.includes("seed=5"), "the gradients have fixed seeds, or every run draws a different one");
  const g = geometryFor(1080);
  assert.ok(graph.includes(`y0=${g.centreY - g.outer}:x1=0:y1=${g.centreY + g.outer}`), "the bars' colours run from the top of the ring to the bottom");
  assert.ok(graph.includes("drawgrid=w=8:h=0:t=2"), "a gap between bars");
  assert.ok(graph.includes("remap"), "bent into a ring");
  assert.ok(!graph.includes("\n"), "one line, as it is passed on the command line");
  assert.ok(!graph.includes(String.fromCharCode(92)), "and nothing in it to escape");
});

test("the sky's colours and the dust move at a speed that suits the size of the picture", () => {
  const small = filterGraph(base);
  const big = filterGraph({ ...base, geometry: geometryFor(1080) });
  assert.ok(small.includes("'mod(t*22,720)'"), "22 pixels a second at 720p");
  assert.ok(big.includes("'mod(t*33,1080)'"), "and 33 at 1080p, the same distance in proportion");
});

test("the hue turn is made on the finished picture, before the words so that they keep their colour", () => {
  const plain = filterGraph(base);
  assert.ok(!plain.includes("hue="), "none when there is nothing to turn");
  const turned = filterGraph({ ...base, hue: hueExpression(section) });
  const at = (text: string) => turned.indexOf(text);
  assert.ok(at("hue=h='") > at("format=yuv420p") && at("hue=h='") < at("subtitles="), "after the conversion to YUV, before the subtitles");
  assert.ok(at("subtitles=captions.ass") < at("fade=t=in"), "the words fade with the picture");
  assert.ok(turned.includes("26*clip((t-20.00)/1.5,0,1)"), "the expression is in, with its commas inside the quotes");
  assert.ok(turned.endsWith("setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]"), "and the encoder is told what the picture is");
});

test("the picture leaves the graph as ordinary video: limited range, BT.709, and said to be", () => {
  for (const hue of ["0", hueExpression(section)]) {
    const graph = filterGraph({ ...base, hue });
    const convert = graph.indexOf("scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p");
    assert.ok(convert > 0, "converted with the range and matrix named, not left to default");
    assert.ok(convert > graph.lastIndexOf("blend="), "after the last blend, which is done in RGB");
    assert.ok(!graph.includes("yuvj"), "never the full-range kind");
  }
});

test("the picture comes up from black and goes out to it, whatever the length of the song", () => {
  assert.deepEqual(fadeTimes(60), { fadeIn: 1.2, fadeOut: 2.5, outAt: 57.5 });
  const short = fadeTimes(4);
  assert.ok(short.fadeIn <= 1 && short.fadeOut < 1.4 && Math.abs(short.outAt + short.fadeOut - 4) < 1e-9, JSON.stringify(short));
  assert.equal(fadeTimes(0.3).outAt >= 0, true);
  const graph = filterGraph(base);
  assert.ok(graph.includes("fade=t=in:st=0:d=1.20,fade=t=out:st=57.50:d=2.50"), "as written into the graph");
});

test("the cover goes in only when there is one, over the sky and in the disc", () => {
  const without = filterGraph(base);
  assert.ok(!without.includes(workFiles.coverDisc) && !without.includes(workFiles.coverBackground));
  const withCover = filterGraph({ ...base, cover: true });
  assert.ok(withCover.includes(`movie=${workFiles.coverBackground}`) && withCover.includes(`movie=${workFiles.coverDisc}`));
  // The tone goes under the dust and the ring, the picture in the disc over the plate that darkens it.
  assert.ok(withCover.indexOf(workFiles.coverBackground) < withCover.indexOf(workFiles.dust + ",") || withCover.indexOf("[tone]") < withCover.indexOf("[dusty]"));
  assert.ok(withCover.indexOf(workFiles.disc) < withCover.indexOf(workFiles.coverDisc), "the cover is shown after the disc is darkened, not under it");
});

test("the command: control video on stdin, the song, the graph, and an H.264 and AAC file that starts quickly", () => {
  const args = renderArgs({ ...base, audio: "song.mp3", output: "video.mp4" });
  const value = (flag: string, from = 0) => args[args.indexOf(flag, from) + 1];
  assert.equal(value("-pix_fmt"), "gray");
  assert.equal(value("-s"), `64x${controlHeight}`);
  assert.equal(value("-r"), String(videoFps));
  assert.equal(args[args.indexOf("pipe:0") - 1], "-i", "the control video comes in on stdin");
  assert.equal(value("-i", args.indexOf("pipe:0")), "song.mp3", "then the song");
  assert.equal(value("-filter_complex"), filterGraph(base));
  assert.deepEqual([args[args.indexOf("-map") + 1], args[args.lastIndexOf("-map") + 1]], ["[v]", "1:a:0"]);
  assert.equal(value("-c:v"), "libx264");
  assert.equal(value("-c:a"), "aac");
  assert.equal(value("-movflags"), "+faststart");
  assert.equal(value("-x264-params"), "aq-mode=3", "bits where it is dark");
  assert.deepEqual([value("-colorspace"), value("-color_primaries"), value("-color_trc"), value("-color_range")], ["bt709", "bt709", "bt709", "tv"]);
  assert.equal(value("-t"), "60.000");
  assert.equal(args[args.length - 1], "video.mp4");
  assert.ok(args.includes("-progress") && args[args.indexOf("-progress") + 1] === "pipe:1", "progress to stdout, which nothing else uses");
  // Every other piece is a plain string: nothing was put through a shell.
  assert.ok(args.every((arg) => typeof arg === "string" && arg.length > 0));
  assert.equal(renderArgs({ ...base, duration: 187.4567, audio: "a", output: "b" }).includes("187.457"), true);
});

test("the cover's own stills are made in a separate pass, once", () => {
  const g = geometryFor(720);
  assert.equal(coverRadius(g), g.inner - 8);
  assert.deepEqual(extractCoverArgs("song.mp3"), ["-y", "-v", "error", "-i", "song.mp3", "-map", "0:v:0", "-frames:v", "1", workFiles.coverSource]);
  const args = coverArgs(g);
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.deepEqual(graphProblems(graph, { outputs: ["[disc]", "[tone]"] }), []);
  const radius = coverRadius(g);
  assert.ok(graph.includes(`scale=${radius * 2}:${radius * 2}:force_original_aspect_ratio=increase,crop=${radius * 2}:${radius * 2}`), "cut to a square the size of the disc");
  assert.ok(graph.includes(`pad=${g.width}:${g.height}:${g.centreX - radius}:${g.centreY - radius}:black`), "placed at the disc's centre");
  assert.ok(graph.includes(`movie=${workFiles.circle}`), "and cut round by the mask");
  assert.deepEqual(args.filter((arg) => arg.endsWith(".png")), [workFiles.coverSource, workFiles.coverDisc, workFiles.coverBackground]);
  assert.ok(args.includes("-frames:v") && args.filter((arg) => arg === "-frames:v").length === 2, "one picture each");
});
