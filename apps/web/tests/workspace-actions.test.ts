import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWorkspaceActionPayload, buildWorkspaceActionPrompt } from '../src/workspaceActions.js';

test('builds a structured prompt for task actions', () => {
  const prompt = buildWorkspaceActionPrompt('Launch checklist', 'Draft launch steps', 'task');
  assert.match(prompt, /Launch checklist/i);
  assert.match(prompt, /task/i);
});

test('builds a workflow prompt for automation actions', () => {
  const prompt = buildWorkspaceActionPrompt('Automation flow', 'Propose a workflow', 'workflow');
  assert.match(prompt, /workflow/i);
  assert.match(prompt, /Automation flow/i);
});

test('builds a persisted payload for workspace actions', () => {
  const payload = buildWorkspaceActionPayload('Launch checklist', 'Draft launch steps', 'task');
  assert.equal(payload.workflowName, 'Launch checklist Workflow');
  assert.match(payload.memoryTitle, /Task:/i);
  assert.equal(payload.workflowDefinition.kind, 'task');
});

test('normalizes prompt punctuation for action detail', () => {
  const prompt = buildWorkspaceActionPrompt('Launch checklist', 'Draft launch steps.', 'task');
  assert.doesNotMatch(prompt, /steps\.\./i);
  assert.match(prompt, /Draft launch steps\. Provide a concise plan/i);
});
