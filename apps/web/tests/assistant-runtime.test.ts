import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDevelopmentPlanDocument, buildLocalAssistantReply, buildLocalAssistantResponseBundle, buildPromptForQuickAction, buildScaffoldSpec, inferAssistantModeFromContext, readPersistedAssistantState, writePersistedAssistantState } from '../src/assistantRuntime.js';

test('builds a local fallback reply for offline mode', () => {
  const reply = buildLocalAssistantReply('coding', 'Help me ship this feature', [], []);
  assert.match(reply, /coding/i);
  assert.match(reply, /feature/i);
});

test('uses recent memory context when available', () => {
  const reply = buildLocalAssistantReply('general', 'Continue the launch plan', [{ title: 'Launch plan', body: 'Launch next week.' }], [
    { role: 'user', content: 'We need a launch checklist' }
  ]);
  assert.match(reply, /Launch plan/i);
  assert.match(reply, /launch/i);
});

test('produces a development blueprint for implementation requests', () => {
  const reply = buildLocalAssistantReply('coding', 'Build a new dashboard widget for team activity', [], []);
  assert.match(reply, /Implementation Blueprint/i);
  assert.match(reply, /Verification/i);
  assert.match(reply, /apps\/web\/src/i);
});

test('builds a structured development plan document for implementation requests', () => {
  const plan = buildDevelopmentPlanDocument('coding', 'Build a new dashboard widget for team activity');
  assert.match(plan, /## Development Plan/i);
  assert.match(plan, /Suggested Files/i);
  assert.match(plan, /apps\/web\/src/i);
});

test('builds a scaffold spec for widget requests', () => {
  const spec = buildScaffoldSpec('Build a new dashboard widget for team activity');
  assert.equal(spec.kind, 'component');
  assert.match(spec.path, /apps\/web\/src\/components\//);
  assert.match(spec.fileName, /TeamActivityWidget/i);
  assert.match(spec.content, /TeamActivityWidget/i);
});

test('builds a documentation scaffold for planning requests', () => {
  const spec = buildScaffoldSpec('Create a spec for the authentication flow');
  assert.equal(spec.kind, 'doc');
  assert.match(spec.path, /docs\//);
  assert.match(spec.fileName, /AuthenticationFlow/i);
  assert.match(spec.content, /# AuthenticationFlow/i);
});

test('includes the scaffold target in the development plan', () => {
  const plan = buildDevelopmentPlanDocument('coding', 'Build a todo list for team tasks');
  assert.match(plan, /apps\/web\/src\/components\//);
  assert.match(plan, /TodoList/i);
});

test('targets a concrete implementation area for task-oriented requests', () => {
  const plan = buildDevelopmentPlanDocument('coding', 'Build a todo list for team tasks');
  assert.match(plan, /apps\/web\/src\/components/);
  assert.match(plan, /Scaffold Target:/i);
});

test('builds a richer implementation scaffold for todo list requests', () => {
  const spec = buildScaffoldSpec('Build a todo list for team tasks');
  assert.equal(spec.kind, 'component');
  assert.match(spec.fileName, /TodoList/i);
  assert.match(spec.content, /useState/i);
  assert.match(spec.content, /sample/i);
});

test('builds a concrete prompt for quick actions', () => {
  assert.equal(
    buildPromptForQuickAction('Run system scan'),
    'Run a system scan and summarize the most urgent findings.'
  );
  assert.equal(
    buildPromptForQuickAction('Optimize mission flow'),
    'Optimize the current mission flow and propose concrete next steps.'
  );
});

test('builds a local assistant response bundle for offline fallback', () => {
  const bundle = buildLocalAssistantResponseBundle('coding', 'Build a todo list', [], [], { path: 'apps/web/src/components/TodoList.tsx' });
  assert.match(bundle.assistantText, /coding/i);
  assert.match(bundle.assistantPlan, /## Development Plan/i);
  assert.match(bundle.assistantScaffold, /Scaffold Spec/i);
  assert.match(bundle.assistantScaffold, /TodoList/i);
});

test('infers the right mode from the active workspace context', () => {
  assert.equal(inferAssistantModeFromContext('Code Studio', 'build the checkout flow'), 'coding');
  assert.equal(inferAssistantModeFromContext('Business Suite', 'prepare the launch brief'), 'business');
  assert.equal(inferAssistantModeFromContext('Image Studio', 'design the hero concept'), 'creator');
});

test('persists and restores assistant state without storing oversized previews', () => {
  const storage = new Map<string, string>();
  const storageLike = {
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length() {
      return storage.size;
    }
  } satisfies Storage;

  writePersistedAssistantState(storageLike, {
    assistantMode: 'coding',
    activeModule: 'Code Studio',
    messages: [
      {
        id: 'msg-1',
        role: 'assistant' as const,
        content: 'Ready',
        createdAt: '2026-01-01T00:00:00.000Z',
        attachments: [{ name: 'hero.png', mimeType: 'image/png', sizeBytes: 120, previewUrl: 'data:image/png;base64,AAA' }]
      }
    ]
  });

  const restored = readPersistedAssistantState(storageLike);
  assert.equal(restored?.assistantMode, 'coding');
  assert.equal(restored?.activeModule, 'Code Studio');
  assert.equal(restored?.messages[0]?.content, 'Ready');
  assert.equal(restored?.messages[0]?.attachments?.[0]?.previewUrl, undefined);
});
