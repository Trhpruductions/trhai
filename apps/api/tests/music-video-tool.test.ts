import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The assistant can start a music video and say how it is getting on. What is tested here is when it is
// offered the tools, what they do with what it passes, and - the part that matters - that nothing it is told
// lets it say a video is made when it is only started.

const workspace = mkdtempSync(path.join(tmpdir(), "trhai-mv-tool-"));
process.env.ASCEND_WORKSPACE = workspace;
mkdirSync(path.join(workspace, "songs"), { recursive: true });
writeFileSync(path.join(workspace, "songs", "neon.mp3"), "a file standing in for a song");

const { availableTools, runTool, toolDefinitions } = await import("../src/services/agentTools.js");
const { mentionsMusicVideo, mentionsVideo } = await import("../src/services/actionIntent.js");
const { describeTools } = await import("../src/services/toolCenter.js");
const { permissionLevelOf } = await import("../src/services/toolPermissions.js");
const { describeMusicVideos } = await import("../src/services/musicVideoFiles.js");
const { resetMusicVideoJob, useMusicVideoRunner, musicVideoStatus } = await import("../src/services/musicVideoJob.js");
const { useFfmpegProbe } = await import("../src/services/ffmpegPath.js");
type Outcome = import("../src/services/musicVideo.js").Outcome;
type MusicVideoRequest = import("../src/services/musicVideo.js").MusicVideoRequest;

const ffmpegRuns = (status: number) => (() => ({ status, error: undefined })) as never;
test.beforeEach(() => { resetMusicVideoJob(); useMusicVideoRunner(); useFfmpegProbe(ffmpegRuns(0)); });
test.afterEach(() => { resetMusicVideoJob(); useMusicVideoRunner(); useFfmpegProbe(); });

const names = (tools: Array<{ function: { name: string } }>) => tools.map((tool) => tool.function.name);

test("a request about a video of a song is told from one about anything else", () => {
  for (const asked of [
    "make a music video from songs/neon.mp3",
    "Turn my song into a video",
    "I want a lyric video for this track",
    "a visualizer for my new single",
    "can you make a karaoke version of this",
    "make a clip for the mp3 on my desktop",
    "put the lyrics on a video"
  ]) assert.equal(mentionsMusicVideo(asked), true, asked);
  for (const asked of [
    "make a video explaining photosynthesis",
    "make a video about our product launch",
    "what is a good song for a road trip",
    "play some music",
    "my album art is blurry",
    "summarise the lyrics of this file",
    "build me a todo app"
  ]) assert.equal(mentionsMusicVideo(asked), false, asked);
  assert.equal(mentionsVideo("make a music video from songs/neon.mp3"), true, "and it is also a request about video");
});

test("asked for a music video, the assistant is offered the music video tools and not the narrated one", () => {
  const music = names(availableTools(true, { musicVideo: true, video: true }));
  assert.ok(music.includes("make_music_video") && music.includes("music_video_status"));
  assert.ok(!music.includes("make_video"), "narrated slides are not what was asked for");
  const slides = names(availableTools(true, { musicVideo: false, video: true }));
  assert.ok(slides.includes("make_video"));
  assert.ok(!slides.includes("make_music_video") && !slides.includes("music_video_status"), "and a request about slides is not offered the song tools");
  const nothing = names(availableTools(true, { musicVideo: false, video: false }));
  assert.ok(!nothing.includes("make_music_video") && !nothing.includes("make_video"));
  assert.ok(names(availableTools(true)).includes("make_music_video"), "with no restrictions given, everything is offered");
});

test("a question is not offered the tool that starts a video", () => {
  const question = names(availableTools(true, { musicVideo: true, changes: false, writes: false }));
  assert.ok(!question.includes("make_music_video"), "starting one is a change to this PC");
  assert.ok(question.includes("music_video_status"), "asking how it is going is a question");
  // Either of the two things that keep a request from changing anything is enough.
  assert.ok(!names(availableTools(true, { musicVideo: true, changes: false })).includes("make_music_video"));
  assert.ok(!names(availableTools(true, { musicVideo: true, writes: false })).includes("make_music_video"));
});

/** A video that takes as long as the test says. */
function slowVideo() {
  const asked: MusicVideoRequest[] = [];
  const run = (request: MusicVideoRequest, context: { signal: AbortSignal }) => new Promise<Outcome>((resolve) => {
    asked.push(request);
    context.signal.addEventListener("abort", () => resolve({ ok: false, reason: "Cancelled.", cancelled: true }));
  });
  return { run, asked };
}
const context = { memories: [], knowledge: [], request: "make a music video from songs/neon.mp3" };

test("starting a video starts it, and says plainly that it is not made", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  const result = await runTool({ name: "make_music_video", arguments: { song: "songs/neon.mp3", title: "Neon Highway", artist: "The Band", lyrics: "one\ntwo", preview: true } }, context);
  assert.equal(result.ok, true, result.content);
  assert.match(result.content, /Started making a music video from songs\/neon\.mp3, a 20-second preview/);
  assert.match(result.content, /NOT finished/);
  assert.match(result.content, /not that it is made/);
  assert.doesNotMatch(result.content, /video\.mp4/, "no path to a video that is not there");
  assert.deepEqual(video.asked, [{ audio: "songs/neon.mp3", title: "Neon Highway", artist: "The Band", lyrics: "one\ntwo", previewSeconds: 20 }]);
  assert.equal(musicVideoStatus().status, "running");
});

test("only what was given is passed on, and a second video waits for the first", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  const first = await runTool({ name: "make_music_video", arguments: { song: "songs/neon.mp3", title: "  ", lyrics: "" } }, context);
  assert.equal(first.ok, true, first.content);
  assert.deepEqual(video.asked, [{ audio: "songs/neon.mp3" }], "blank text is nothing");
  assert.doesNotMatch(first.content, /preview/);
  const second = await runTool({ name: "make_music_video", arguments: { song: "songs/neon.mp3" } }, context);
  assert.equal(second.ok, false);
  assert.match(second.content, /still being made/);
  assert.equal(video.asked.length, 1);
});

test("a video that cannot be started says why, and nothing starts", async () => {
  const video = slowVideo();
  useMusicVideoRunner(video.run);
  const say = async (args: Record<string, unknown>) => {
    const result = await runTool({ name: "make_music_video", arguments: args }, context);
    assert.equal(result.ok, false, JSON.stringify(args));
    return result.content;
  };
  assert.match(await say({}), /needs the song's path/);
  assert.match(await say({ song: "songs/missing.mp3" }), /There is no song at "songs\/missing\.mp3"/);
  assert.match(await say({ song: "../outside.mp3" }), /outside the workspace/);
  assert.match(await say({ song: "songs/neon.mp3", artist: "x".repeat(300) }), /artist/);
  useFfmpegProbe(ffmpegRuns(1));
  assert.match(await say({ song: "songs/neon.mp3" }), /ffmpeg is not installed/);
  assert.deepEqual(video.asked, []);
  assert.equal(musicVideoStatus().status, "idle");
});

test("how a video is getting on is told in what is true, and a finished one is told with its place", async () => {
  const idle = await runTool({ name: "music_video_status", arguments: {} }, context);
  assert.equal(idle.ok, true);
  assert.match(idle.content, /No music video is being made\./);
  assert.match(idle.content, /None have been made yet\./);

  const entry = { title: "Older", preview: false, seconds: 187, video: "music-videos/older/video.mp4" } as never;
  const running = describeMusicVideos({ status: "running", id: "1", title: "Neon Highway", preview: false, stage: "drawing", fraction: 0.42, message: "Drawing the video, 40%", startedAt: 0, elapsedSeconds: 95, cancelling: false }, [entry]);
  assert.match(running, /"Neon Highway"/);
  assert.match(running, /42% of the way, 1:35 so far/);
  assert.match(running, /It is not finished yet\./);
  assert.match(running, /Made so far: "Older" \(3:07\) at music-videos\/older\/video\.mp4\./);
  assert.doesNotMatch(running, /finished:/);

  const done = describeMusicVideos({ status: "done", id: "1", finishedAt: 0, elapsedSeconds: 60, result: { folder: "music-videos/x", video: "music-videos/x/video.mp4", thumbnail: "t", title: "X", artist: "", seconds: 68, height: 1080, bpm: 120, palette: "neon", lyricLines: 3, lyricsTiming: "heard", cover: false, preview: false, warnings: ["Only 40% of your words were found."], bytes: 43_451_268 } }, []);
  assert.match(done, /The last music video finished: "X", 1:08 at 1080p, 41 MB, at music-videos\/x\/video\.mp4\./);
  assert.match(done, /Notes about it: Only 40% of your words were found\./);

  assert.match(describeMusicVideos({ status: "failed", id: "1", reason: "ffmpeg stopped.", finishedAt: 0 }, []), /could not be made: ffmpeg stopped\./);
  assert.match(describeMusicVideos({ status: "cancelled", id: "1", finishedAt: 0 }, []), /stopped before it finished, and nothing was kept/);
  assert.match(describeMusicVideos({ status: "idle" }, [{ ...(entry as object), preview: true } as never]), /\(preview\)/);
});

test("the tools are in the tool centre with a level, and say what they need", () => {
  const probe = (ffmpeg: boolean) => ({
    machineAccess: { armed: false, until: null }, model: { available: false, name: null, reason: null }, visionModel: null, ffmpeg, piper: false, phoneLink: "missing" as const, emailAccount: null
  });
  const find = (ffmpeg: boolean, name: string) => describeTools(probe(ffmpeg)).find((tool) => tool.name === name);
  const ready = find(true, "make_music_video");
  assert.ok(ready);
  assert.equal(ready.area, "Media");
  assert.equal(ready.readiness.state, "ready");
  assert.equal(ready.level, 2);
  assert.equal(find(false, "make_music_video")?.readiness.state, "needs-setup");
  assert.match(find(false, "make_music_video")?.readiness.note ?? "", /ffmpeg/);
  assert.equal(find(true, "music_video_status")?.level, 1);
  assert.equal(permissionLevelOf("make_music_video"), 2);
  assert.equal(permissionLevelOf("music_video_status"), 1);
  assert.ok(toolDefinitions.some((tool) => tool.function.name === "make_music_video" && tool.function.parameters.required.includes("song")));
});
