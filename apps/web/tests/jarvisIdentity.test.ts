import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getJarvisBrandName,
  getJarvisGreeting,
  getJarvisMissionLine,
  getJarvisWelcomeMessage,
  getJarvisDirectiveHint,
  getJarvisLiveViewStatus,
  getJarvisMissionSnapshot,
  getJarvisMissionPulse,
  getJarvisMissionBoard
} from '../src/jarvisIdentity.js';

test('returns jarvis identity copy', () => {
  assert.equal(getJarvisBrandName(), 'JARVIS');
  assert.match(getJarvisGreeting(true), /boot sequence/i);
  assert.match(getJarvisWelcomeMessage(), /online/i);
  assert.match(getJarvisMissionLine(), /mission control/i);
  assert.match(getJarvisDirectiveHint(), /directive/i);
});

test('builds a live view status summary', () => {
  const status = getJarvisLiveViewStatus('AI Chat', true, false, true);
  assert.match(status.headline, /live view/i);
  assert.match(status.detail, /boot/i);
  assert.match(status.mode, /responding/i);
});

test('builds a mission snapshot summary', () => {
  const snapshot = getJarvisMissionSnapshot('Projects', 4, 3, 2);
  assert.match(snapshot.headline, /mission/i);
  assert.equal(snapshot.metrics.projects, 4);
  assert.equal(snapshot.metrics.operators, 3);
  assert.equal(snapshot.metrics.questions, 2);
});

test('builds a mission pulse summary', () => {
  const pulse = getJarvisMissionPulse('Projects', 3, 2);
  assert.match(pulse.headline, /pulse/i);
  assert.equal(pulse.metrics.readiness, 3);
  assert.equal(pulse.metrics.focus, 2);
});

test('builds a mission board summary', () => {
  const board = getJarvisMissionBoard('AI Chat', 2, 1);
  assert.match(board.headline, /board/i);
  assert.equal(board.metrics.active, 2);
  assert.equal(board.metrics.alerts, 1);
});
