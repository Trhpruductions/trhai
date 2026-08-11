import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatStageDuration,
  reasoningStageOrder,
  summarizeReasoningStages,
  type ReasoningStageEvent
} from '../src/reasoningStages.js';

test('reports every stage as pending when no events exist', () => {
  const summary = summarizeReasoningStages([], 1000);

  assert.equal(summary.activeStage, null);
  assert.equal(summary.totalMs, 0);
  assert.deepEqual(
    summary.stages.map((stage) => stage.stage),
    reasoningStageOrder
  );
  assert.ok(summary.stages.every((stage) => stage.status === 'pending' && stage.durationMs === 0));
});

test('attributes duration to the stage that was in effect', () => {
  const events: ReasoningStageEvent[] = [
    { stage: 'understanding', level: 'info', createdAt: 1000 },
    { stage: 'context', level: 'info', createdAt: 1400 },
    { stage: 'planning', level: 'ok', createdAt: 2000 }
  ];

  const summary = summarizeReasoningStages(events, 2500);
  const byStage = new Map(summary.stages.map((stage) => [stage.stage, stage]));

  assert.equal(byStage.get('understanding')!.durationMs, 400);
  assert.equal(byStage.get('context')!.durationMs, 600);
  assert.equal(byStage.get('planning')!.durationMs, 500);
  assert.equal(byStage.get('building')!.durationMs, 0);
  assert.equal(summary.totalMs, 1500);
});

test('accepts newest-first event order as stored by app state', () => {
  const newestFirst: ReasoningStageEvent[] = [
    { stage: 'planning', level: 'ok', createdAt: 2000 },
    { stage: 'context', level: 'info', createdAt: 1400 },
    { stage: 'understanding', level: 'info', createdAt: 1000 }
  ];

  const summary = summarizeReasoningStages(newestFirst, 2500);

  assert.equal(summary.activeStage, 'planning');
  assert.equal(summary.stages.find((stage) => stage.stage === 'understanding')!.durationMs, 400);
});

test('treats the earlier array position as newer when timestamps tie', () => {
  // Two checkpoints emitted in the same millisecond, stored newest-first.
  const summary = summarizeReasoningStages(
    [
      { stage: 'verifying', level: 'ok', createdAt: 2000 },
      { stage: 'planning', level: 'ok', createdAt: 2000 },
      { stage: 'understanding', level: 'ok', createdAt: 1000 }
    ],
    2500
  );

  assert.equal(summary.activeStage, 'verifying');
  assert.equal(summary.stages.find((stage) => stage.stage === 'verifying')!.durationMs, 500);
  assert.equal(summary.stages.find((stage) => stage.stage === 'planning')!.durationMs, 0);
});

test('marks the most recent clean stage as active', () => {
  const summary = summarizeReasoningStages(
    [
      { stage: 'understanding', level: 'ok', createdAt: 1000 },
      { stage: 'building', level: 'ok', createdAt: 1200 }
    ],
    1500
  );

  assert.equal(summary.activeStage, 'building');
  assert.equal(summary.stages.find((stage) => stage.stage === 'building')!.status, 'active');
  assert.equal(summary.stages.find((stage) => stage.stage === 'understanding')!.status, 'done');
});

test('keeps a failing latest stage visible instead of showing it as active', () => {
  const summary = summarizeReasoningStages(
    [
      { stage: 'building', level: 'ok', createdAt: 1000 },
      { stage: 'verifying', level: 'error', createdAt: 1200 }
    ],
    1500
  );

  assert.equal(summary.activeStage, 'verifying');
  assert.equal(summary.stages.find((stage) => stage.stage === 'verifying')!.status, 'error');
});

test('lets a later success clear an earlier stage failure', () => {
  const summary = summarizeReasoningStages(
    [
      { stage: 'verifying', level: 'error', createdAt: 1000 },
      { stage: 'building', level: 'ok', createdAt: 1100 },
      { stage: 'verifying', level: 'ok', createdAt: 1200 }
    ],
    1300
  );

  const verifying = summary.stages.find((stage) => stage.stage === 'verifying')!;
  assert.equal(verifying.status, 'active');
  assert.equal(verifying.events, 2);
  // 1000->1100 plus 1200->now
  assert.equal(verifying.durationMs, 200);
});

test('ignores events outside the known stage set', () => {
  const summary = summarizeReasoningStages(
    [
      { stage: 'planning', level: 'ok', createdAt: 1000 },
      { stage: 'bogus' as never, level: 'ok', createdAt: 1100 }
    ],
    1200
  );

  assert.equal(summary.activeStage, 'planning');
  assert.equal(summary.stages.reduce((total, stage) => total + stage.events, 0), 1);
});

test('formats stage durations across magnitudes', () => {
  assert.equal(formatStageDuration(0), '—');
  assert.equal(formatStageDuration(-5), '—');
  assert.equal(formatStageDuration(420), '420ms');
  assert.equal(formatStageDuration(1500), '1.5s');
  assert.equal(formatStageDuration(95000), '1m 35s');
});
