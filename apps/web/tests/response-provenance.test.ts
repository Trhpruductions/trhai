import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResponseProvenance,
  sanitizeResponseProvenance,
  summarizeDegradedState,
  type ResponseProvenance
} from '../src/responseProvenance.js';

function fallback(): ResponseProvenance {
  return buildResponseProvenance({ apiModel: null, attempts: 3 });
}

function modelReply(attempts = 1): ResponseProvenance {
  return buildResponseProvenance({ apiModel: 'ascend-router-v1', attempts });
}

test('labels a model-backed reply with high confidence', () => {
  const provenance = modelReply();

  assert.equal(provenance.origin, 'model');
  assert.equal(provenance.confidence, 'high');
  assert.equal(provenance.model, 'ascend-router-v1');
  assert.deepEqual(provenance.sources, ['model']);
});

test('labels a local fallback with reduced confidence and no model id', () => {
  const provenance = fallback();

  assert.equal(provenance.origin, 'local-fallback');
  assert.equal(provenance.confidence, 'reduced');
  assert.equal(provenance.model, null);
  assert.deepEqual(provenance.sources, ['local-heuristic']);
  assert.match(provenance.note, /generated locally/i);
});

test('does not claim a model when the api returned a blank model id', () => {
  const provenance = buildResponseProvenance({ apiModel: '   ', attempts: 1 });

  assert.equal(provenance.origin, 'local-fallback');
  assert.equal(provenance.model, null);
});

test('adds the conversation source only when the api reported using history', () => {
  const withHistory = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedHistoryTurns: 4 });
  const noHistory = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedHistoryTurns: 0 });
  const unreported = buildResponseProvenance({ apiModel: 'm', attempts: 1 });

  assert.deepEqual(withHistory.sources, ['model', 'conversation']);
  assert.deepEqual(noHistory.sources, ['model']);
  assert.deepEqual(unreported.sources, ['model']);
});

test('never claims conversation history on a local fallback', () => {
  // The API was never reached, so it cannot have consumed history.
  const provenance = buildResponseProvenance({ apiModel: null, attempts: 3, usedHistoryTurns: 6 });

  assert.deepEqual(provenance.sources, ['local-heuristic']);
});

test('ignores a nonsense history count from the api', () => {
  const negative = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedHistoryTurns: -3 });
  const notFinite = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedHistoryTurns: Number.NaN });

  assert.deepEqual(negative.sources, ['model']);
  assert.deepEqual(notFinite.sources, ['model']);
});

test('orders sources model, memory, conversation, then blueprint', () => {
  const provenance = buildResponseProvenance({
    apiModel: 'm',
    attempts: 1,
    usedMemoryEntries: 3,
    usedHistoryTurns: 2,
    usedBlueprint: true
  });

  assert.deepEqual(provenance.sources, ['model', 'memory', 'conversation', 'blueprint']);
});

test('adds the memory source only when the api reported using memory', () => {
  const withMemory = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedMemoryEntries: 2 });
  const without = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedMemoryEntries: 0 });

  assert.deepEqual(withMemory.sources, ['model', 'memory']);
  assert.deepEqual(without.sources, ['model']);
});

test('never claims memory on a local fallback', () => {
  const provenance = buildResponseProvenance({ apiModel: null, attempts: 3, usedMemoryEntries: 5 });

  assert.deepEqual(provenance.sources, ['local-heuristic']);
});

test('adds the blueprint source only when a blueprint was merged in', () => {
  const withBlueprint = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedBlueprint: true });
  const without = buildResponseProvenance({ apiModel: 'm', attempts: 1, usedBlueprint: false });

  assert.deepEqual(withBlueprint.sources, ['model', 'blueprint']);
  assert.deepEqual(without.sources, ['model']);
});

test('notes recovery when the reply needed retries', () => {
  assert.match(modelReply(3).note, /Recovered after 3 attempts/);
  assert.match(modelReply(1).note, /Delivered by the assistant API/);
});

test('clamps nonsense attempt counts', () => {
  assert.equal(buildResponseProvenance({ apiModel: 'm', attempts: 0 }).attempts, 1);
  assert.equal(buildResponseProvenance({ apiModel: 'm', attempts: -4 }).attempts, 1);
  assert.equal(buildResponseProvenance({ apiModel: 'm', attempts: Number.NaN }).attempts, 1);
  assert.equal(buildResponseProvenance({ apiModel: 'm', attempts: 1e9 }).attempts, 99);
});

test('reports no degraded state for an empty or healthy history', () => {
  assert.equal(summarizeDegradedState([]).degraded, false);

  const healthy = summarizeDegradedState([modelReply(), modelReply()]);
  assert.equal(healthy.degraded, false);
  assert.equal(healthy.recovered, false);
  assert.equal(healthy.label, '');
});

test('counts only the trailing run of fallbacks', () => {
  const state = summarizeDegradedState([fallback(), modelReply(), fallback(), fallback()]);

  assert.equal(state.degraded, true);
  assert.equal(state.consecutiveFallbacks, 2);
  assert.match(state.label, /last 2 replies/);
});

test('uses singular copy for a single fallback', () => {
  const state = summarizeDegradedState([modelReply(), fallback()]);

  assert.equal(state.consecutiveFallbacks, 1);
  assert.match(state.label, /last reply was generated locally/);
});

test('surfaces recovery when a model reply follows a recent fallback', () => {
  const state = summarizeDegradedState([fallback(), modelReply()]);

  assert.equal(state.degraded, false);
  assert.equal(state.recovered, true);
  assert.match(state.label, /recovered/i);
});

test('stops reporting recovery once the outage falls out of the lookback window', () => {
  const state = summarizeDegradedState([
    fallback(),
    modelReply(),
    modelReply(),
    modelReply(),
    modelReply(),
    modelReply()
  ]);

  assert.equal(state.recovered, false);
  assert.equal(state.label, '');
});

test('rejects malformed persisted provenance', () => {
  assert.equal(sanitizeResponseProvenance(null), null);
  assert.equal(sanitizeResponseProvenance('model'), null);
  assert.equal(sanitizeResponseProvenance({ origin: 'wat' }), null);
});

test('repairs partially valid persisted provenance', () => {
  const restored = sanitizeResponseProvenance({
    origin: 'local-fallback',
    sources: ['local-heuristic', 'not-a-source', 42],
    model: '  ',
    attempts: '3',
    confidence: 'bogus'
  });

  assert.ok(restored);
  assert.deepEqual(restored.sources, ['local-heuristic']);
  assert.equal(restored.model, null);
  assert.equal(restored.attempts, 1);
  assert.equal(restored.confidence, 'reduced');
});

test('backfills a source class when the stored list is unusable', () => {
  const restored = sanitizeResponseProvenance({ origin: 'model', sources: ['junk'] });

  assert.ok(restored);
  assert.deepEqual(restored.sources, ['model']);
});
