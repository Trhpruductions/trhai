import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex, stableSerialize, verifySignedJsonExport, verifySignedMarkdownExport } from '../src/exportIntegrity.js';

test('stableSerialize sorts object keys deterministically', () => {
  const left = stableSerialize({ b: 2, a: 1, nested: { z: 3, c: 4 } });
  const right = stableSerialize({ nested: { c: 4, z: 3 }, a: 1, b: 2 });
  assert.equal(left, right);
});

test('verifies signed json export payload', async () => {
  const content = {
    exportedAt: '2026-08-02T00:00:00.000Z',
    triage: {
      retention: 'all',
      visibleCount: 1,
      totalCount: 1,
      events: [
        {
          id: 'evt-1',
          action: 'acknowledge',
          detail: 'Acknowledged failing run.',
          runId: 'run-1',
          createdAt: '2026-08-02T00:00:00.000Z'
        }
      ]
    }
  };

  const contentHash = await sha256Hex(stableSerialize(content));
  const payload = {
    ...content,
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'sorted-keys-v1',
      contentHash
    }
  };

  await assert.doesNotReject(async () => verifySignedJsonExport(JSON.stringify(payload)));
});

test('rejects tampered signed json export payload', async () => {
  const content = {
    exportedAt: '2026-08-02T00:00:00.000Z',
    triage: { retention: 'all', visibleCount: 1, totalCount: 1, events: [] }
  };
  const contentHash = await sha256Hex(stableSerialize(content));
  const payload = {
    ...content,
    triage: { retention: '24h', visibleCount: 1, totalCount: 1, events: [] },
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'sorted-keys-v1',
      contentHash
    }
  };

  await assert.rejects(async () => verifySignedJsonExport(JSON.stringify(payload)), /Integrity mismatch/i);
});

test('verifies signed markdown export payload', async () => {
  const body = [
    '# Ascend AI Triage Timeline',
    '',
    '- Exported At: 2026-08-02T00:00:00.000Z',
    '- Retention Filter: all',
    '',
    '## Events',
    '',
    '### ACKNOWLEDGE',
    '- Time: 2026-08-02T00:00:00.000Z',
    '- Detail: Acknowledged failing run.',
    '- Run: run-1'
  ].join('\n');

  const contentHash = await sha256Hex(body);
  const markdown = [
    '<!-- integrity.algorithm: SHA-256 -->',
    '<!-- integrity.scope: markdown-body -->',
    `<!-- integrity.contentHash: ${contentHash} -->`,
    '',
    body
  ].join('\n');

  await assert.doesNotReject(async () => verifySignedMarkdownExport(markdown));
});

test('rejects tampered signed markdown export payload', async () => {
  const body = '# Header\n\nBody text';
  const contentHash = await sha256Hex(body);
  const markdown = [
    '<!-- integrity.algorithm: SHA-256 -->',
    '<!-- integrity.scope: markdown-body -->',
    `<!-- integrity.contentHash: ${contentHash} -->`,
    '',
    '# Header',
    '',
    'Body text tampered'
  ].join('\n');

  await assert.rejects(async () => verifySignedMarkdownExport(markdown), /Integrity mismatch/i);
});
