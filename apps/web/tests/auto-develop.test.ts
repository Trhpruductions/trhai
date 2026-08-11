import test from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeQuestion, shouldAutoDevelop } from '../src/autoDevelop.js';

test('only a plan strategy triggers scaffolding', () => {
  assert.equal(shouldAutoDevelop('plan', 'Build a dashboard'), true);
  assert.equal(shouldAutoDevelop('answer', 'What database do we use?'), false);
  assert.equal(shouldAutoDevelop('no-answer', 'What is our refund policy?'), false);
  assert.equal(shouldAutoDevelop('clarify', 'do it'), false);
  assert.equal(shouldAutoDevelop('acknowledge', 'Remember that we use pnpm'), false);
  // A question about the spec must not write files before it is answered.
  assert.equal(shouldAutoDevelop('clarify-build', 'Build a CRM'), false);
});

test('server strategy wins over the local heuristic', () => {
  // Phrased as a question but the server classified it as work to do.
  assert.equal(shouldAutoDevelop('plan', 'Can you build the reporting service?'), true);
  // Phrased as a command but the server answered it instead.
  assert.equal(shouldAutoDevelop('answer', 'Tell me our database standard'), false);
});

test('falls back to the local heuristic when the api reports no strategy', () => {
  assert.equal(shouldAutoDevelop(undefined, 'What database should we use?'), false);
  assert.equal(shouldAutoDevelop(undefined, 'Build a revenue dashboard'), true);
  assert.equal(shouldAutoDevelop('', 'Which framework do we use?'), false);
});

test('recognizes question shapes without a question mark', () => {
  assert.equal(looksLikeQuestion('What database do we use'), true);
  assert.equal(looksLikeQuestion('Remind me what we decided'), true);
  assert.equal(looksLikeQuestion('How do I run the tests'), true);
  assert.equal(looksLikeQuestion('Build a dashboard'), false);
});

test('treats a trailing question mark as a question regardless of wording', () => {
  assert.equal(looksLikeQuestion('Postgres or MySQL?'), true);
  assert.equal(shouldAutoDevelop(undefined, 'Postgres or MySQL?'), false);
});
