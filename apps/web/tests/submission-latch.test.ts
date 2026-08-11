import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubmissionLatch } from '../src/submissionLatch.js';

test('blocks a second acquire in the same tick', () => {
  const latch = createSubmissionLatch();

  // This is the actual reproduced bug: two handler invocations, one user action.
  assert.equal(latch.tryAcquire('build a thing', 1000), true);
  assert.equal(latch.tryAcquire('build a thing', 1000), false);
});

test('blocks a different request while one is still in flight', () => {
  const latch = createSubmissionLatch();

  assert.equal(latch.tryAcquire('first', 1000), true);
  assert.equal(latch.tryAcquire('second', 1000), false);
});

test('allows a different request once the previous one is released', () => {
  const latch = createSubmissionLatch();

  latch.tryAcquire('first', 1000);
  latch.release();

  assert.equal(latch.tryAcquire('second', 1010), true);
});

test('suppresses an identical resubmit inside the cooldown window', () => {
  const latch = createSubmissionLatch(1200);

  latch.tryAcquire('same request', 1000);
  latch.release();

  assert.equal(latch.tryAcquire('same request', 1500), false);
  assert.equal(latch.tryAcquire('same request', 2100), false);
});

test('allows an identical resubmit once the cooldown expires', () => {
  const latch = createSubmissionLatch(1200);

  latch.tryAcquire('same request', 1000);
  latch.release();

  assert.equal(latch.tryAcquire('same request', 2200), true);
});

test('never blocks a genuinely different follow-up request', () => {
  const latch = createSubmissionLatch(1200);

  latch.tryAcquire('first request', 1000);
  latch.release();

  // A user typing a new message immediately must not be suppressed.
  assert.equal(latch.tryAcquire('second request', 1050), true);
});

test('cooldown 0 guards re-entry but never blocks a deliberate retry', () => {
  // Used for scaffold / desktop command / screen actions, where repeating the
  // same action on purpose must always be allowed once the previous one finished.
  const latch = createSubmissionLatch(0);

  assert.equal(latch.tryAcquire('scaffold:thing', 1000), true);
  assert.equal(latch.tryAcquire('scaffold:thing', 1000), false, 'same-tick re-entry blocked');

  latch.release();

  assert.equal(latch.tryAcquire('scaffold:thing', 1000), true, 'immediate retry allowed');
});

test('reports busy state across acquire and release', () => {
  const latch = createSubmissionLatch();

  assert.equal(latch.isBusy(), false);
  latch.tryAcquire('x', 1000);
  assert.equal(latch.isBusy(), true);
  latch.release();
  assert.equal(latch.isBusy(), false);
});

test('release is safe to call when nothing was acquired', () => {
  const latch = createSubmissionLatch();

  latch.release();
  assert.equal(latch.isBusy(), false);
  assert.equal(latch.tryAcquire('x', 1000), true);
});

test('a failed submission still frees the latch for a retry', () => {
  const latch = createSubmissionLatch(1200);

  latch.tryAcquire('flaky request', 1000);
  latch.release();

  // Same text after the cooldown is a legitimate manual retry.
  assert.equal(latch.tryAcquire('flaky request', 2300), true);
});
