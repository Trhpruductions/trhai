import test from "node:test";
import assert from "node:assert/strict";
import { wantsMediaConverted, wantsSpeechFile } from "../src/services/actionIntent.js";

// When a request is one for text to be read out into an audio file - and when it only mentions speech, audio or a format.
// A tool that makes files is worth offering only to the first.

test("asking for text to be read out into an audio file is recognised", () => {
  for (const request of [
    "Read this to an mp3: Hello there, this is a test.",
    "read this story out to a wav file in the Jarvis voice",
    "make an audio file of this story",
    "make an audio recording of the following text",
    "turn this text into speech and save it as a wav",
    "convert this poem to an mp3",
    "can you turn my script into an audio file",
    "I need a voiceover for this script",
    "make a narration of the article below",
    "text to speech: save this as an mp3 please",
    "create an audiobook from this chapter",
    "say this as an mp3 in Amy's voice",
    "record the following message as an audio file",
    "narrate these lines into a flac"
  ]) {
    assert.equal(wantsSpeechFile(request), true, request);
  }
});

test("reading aloud now, converting a file that exists, and other uses of the words are not", () => {
  for (const request of [
    "read this aloud",
    "read the file notes.txt",
    "what does TTS stand for",
    "convert song.wav to mp3",
    "extract the audio from clip.mp4",
    "make a music video from song.mp3",
    "turn the volume up",
    "play some music",
    "how do I save a file as a wav in audacity",
    "write a poem about the sea",
    "make a presentation about voice assistants",
    "what is a good microphone for recording audio",
    "",
    "hello"
  ]) {
    assert.equal(wantsSpeechFile(request), false, request);
  }
  assert.equal(wantsSpeechFile(undefined as unknown as string), false);
});

test("a request for one of the two is not a request for the other", () => {
  assert.equal(wantsMediaConverted("convert this story to an mp3"), false, "words to read out are not a file to convert");
  assert.equal(wantsMediaConverted("save this poem as a wav"), false);
  assert.equal(wantsMediaConverted("convert song.wav to mp3"), true);
  assert.equal(wantsMediaConverted("convert my recording to mp3"), true);
  assert.equal(wantsMediaConverted("extract the audio from this video"), true);
  assert.equal(wantsSpeechFile("convert song.wav to mp3"), false);
  assert.equal(wantsSpeechFile("convert my recording to mp3"), false);
});
