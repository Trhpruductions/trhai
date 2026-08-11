import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accountTokenStorageKey,
  authHeaders,
  readAuthResponse,
  readStoredToken,
  validateCredentials,
  writeStoredToken
} from '../src/accountClient.js';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, value); }
  } as Storage;
}

test('reads and writes the stored token', () => {
  const storage = fakeStorage();

  assert.equal(readStoredToken(storage), null);
  writeStoredToken(storage, 'abc123');
  assert.equal(readStoredToken(storage), 'abc123');
  assert.equal(storage.getItem(accountTokenStorageKey), 'abc123');
});

test('clearing the token removes it rather than storing empty', () => {
  const storage = fakeStorage({ [accountTokenStorageKey]: 'abc123' });

  writeStoredToken(storage, null);
  assert.equal(storage.getItem(accountTokenStorageKey), null);
});

test('treats a blank stored token as signed out', () => {
  assert.equal(readStoredToken(fakeStorage({ [accountTokenStorageKey]: '   ' })), null);
});

test('survives storage being unavailable', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  } as unknown as Storage;

  assert.equal(readStoredToken(blocked), null);
  assert.doesNotThrow(() => writeStoredToken(blocked, 'abc'));
  assert.equal(readStoredToken(undefined), null);
});

test('sends an auth header only when signed in', () => {
  assert.deepEqual(authHeaders('abc123'), { Authorization: 'Bearer abc123' });
  assert.deepEqual(authHeaders(null), {});
});

test('reads a successful auth response', () => {
  const account = { id: '1', email: 'a@b.co', displayName: 'A', createdAt: 'now' };
  const result = readAuthResponse(201, { data: { account, token: 'tok' } });

  assert.ok(result.ok);
  assert.equal(result.token, 'tok');
  assert.equal(result.account.email, 'a@b.co');
  assert.deepEqual(result.recoveryCodes, [], 'login returns no codes');
});

test('captures recovery codes when registration returns them', () => {
  const account = { id: '1', email: 'a@b.co', displayName: 'A', createdAt: 'now' };
  const result = readAuthResponse(201, {
    data: { account, token: 'tok', recoveryCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'] }
  });

  assert.ok(result.ok);
  assert.equal(result.recoveryCodes.length, 2);
});

test('ignores a malformed recovery code list', () => {
  const account = { id: '1', email: 'a@b.co', displayName: 'A', createdAt: 'now' };
  const result = readAuthResponse(201, {
    data: { account, token: 'tok', recoveryCodes: ['GOOD-CODE-HERE', 42, null] }
  });

  assert.ok(result.ok);
  assert.deepEqual(result.recoveryCodes, ['GOOD-CODE-HERE']);
});

test('surfaces the server message on failure', () => {
  const result = readAuthResponse(401, { message: 'Email or password is incorrect' });

  assert.ok(!result.ok);
  assert.equal(result.error, 'Email or password is incorrect');
});

test('surfaces a rate-limit message so the user knows to wait', () => {
  const result = readAuthResponse(429, {
    message: 'Too many attempts. Please wait and try again.',
    retryAfterSeconds: 42
  });

  assert.ok(!result.ok);
  assert.match(result.error, /too many attempts/i);
});

test('falls back to a generic message when the server sends none', () => {
  const result = readAuthResponse(500, {});

  assert.ok(!result.ok);
  assert.match(result.error, /failed/i);
});

test('treats a 2xx without a token as failure rather than signed in', () => {
  const result = readAuthResponse(200, { data: { account: { id: '1' } } });

  assert.ok(!result.ok);
});

test('validates credentials before hitting the network', () => {
  assert.match(validateCredentials('not-an-email', 'correct horse battery') ?? '', /email/i);
  assert.match(validateCredentials('a@b.co', 'short') ?? '', /10 characters/i);
  assert.equal(validateCredentials('a@b.co', 'correct horse battery'), null);
});
