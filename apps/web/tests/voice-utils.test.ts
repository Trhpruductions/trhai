import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVoiceProfile, normalizeVoiceTranscript } from '../src/voiceUtils.js';

test('normalizes blank and filler transcripts', () => {
  assert.equal(normalizeVoiceTranscript('   '), '');
  assert.equal(normalizeVoiceTranscript('[BLANK_AUDIO]'), '');
  assert.equal(normalizeVoiceTranscript('uh'), '');
  assert.equal(normalizeVoiceTranscript('Hello there'), 'Hello there');
});

test('cleans up noisy speech before speaking it back', () => {
  assert.equal(normalizeVoiceTranscript('  hello   there  '), 'hello there');
  assert.equal(normalizeVoiceTranscript('[INAUDIBLE]'), '');
});

test('builds a more expressive voice profile for development requests', () => {
  const profile = buildVoiceProfile('Build a new dashboard widget for team activity', 'coding');
  assert.ok(profile.rate >= 0.95);
  assert.ok(profile.pitch >= 0.8);
  assert.ok(profile.volume >= 0.95);
});

test('builds a richer creator profile for visual and audio requests', () => {
  const profile = buildVoiceProfile('Design a cinematic hero concept for the launch', 'creator');
  assert.ok(profile.rate >= 0.95);
  assert.ok(profile.pitch >= 0.85);
  assert.ok(profile.volume >= 0.95);
});
