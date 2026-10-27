import test from "node:test";
import assert from "node:assert/strict";
import { wantsMediaConverted } from "../src/services/actionIntent.js";

// When a request is one for converting, trimming or pulling the sound out of an audio or video file - and when it only
// mentions the same words. A tool that changes files is worth offering only to the first.

test("asking for a file to be converted, trimmed or stripped to its sound is recognised", () => {
  for (const request of [
    "convert song.wav to mp3",
    "Convert my recording to mp3",
    "can you turn neon.flac into a wav",
    "extract the audio from clip.mp4",
    "rip the sound out of this video",
    "pull the audio out of holiday.mov and save it",
    "trim intro.mp3 to the first 30 seconds",
    "shorten podcast.m4a to ten minutes",
    "compress holiday.mov so I can email it",
    "save this video as mp4",
    "re-encode talk.mkv to mp4",
    "export the song as a flac",
    "cut the first ten seconds off beat.wav",
    "Convert voice memo.m4a to mp3 please",
    "transcode the opus file to ogg",
    "make my-mix.wav into an mp3",
    "I need take_2.aiff as a wav"
  ]) {
    assert.equal(wantsMediaConverted(request), true, request);
  }
});

test("a music video, a plain mention of a format, and other kinds of conversion are not", () => {
  for (const request of [
    "make a music video from neon.mp3",
    "turn this song into a music video",
    "make a lyric video for this track",
    "I want a visualizer for song.wav",
    "make a karaoke video of this song",
    "make a video of the song as mp4",
    "write a poem about mp3 players",
    "make a video about cats",
    "how do I convert a docx to pdf",
    "convert the report to pdf",
    "save the report as a pdf",
    "cut the budget by ten percent",
    "trim the hedge on Saturday",
    "extract the zip file into a folder",
    "what is the best bitrate for mp3",
    "play song.mp3",
    "I want to listen to some music",
    "get this clip to youtube",
    "",
    "hello"
  ]) {
    assert.equal(wantsMediaConverted(request), false, request);
  }
  assert.equal(wantsMediaConverted(undefined as unknown as string), false);
});
