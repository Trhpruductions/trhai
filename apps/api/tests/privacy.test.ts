import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { legalFacts, legalVersions } from "@ascend/shared";
import { consents } from "./helpers/consents.js";

// What a person agreed to, the copy of their data they can take, and erasure - through a
// real server, with every store pointed at a throwaway folder.
//
// The questions each test answers are the ones a reader of the Privacy Policy would ask:
// was what I agreed to kept, is the copy complete and free of secrets, and when I say
// erase, is it gone - from the stores, from the copies of them, from the sign-in?
const dir = mkdtempSync(path.join(tmpdir(), "trhai-privacy-"));
const accountsFile = path.join(dir, "accounts.json");
const requestsFile = path.join(dir, "privacy-requests.json");
const auditFile = path.join(dir, "audit.json");
process.env.ASSIST_ACCOUNTS_FILE = accountsFile;
process.env.ASSIST_PRIVACY_REQUESTS_FILE = requestsFile;
process.env.ASSIST_AUDIT_FILE = auditFile;
process.env.ASSIST_MEMORY_FILE = path.join(dir, "memory.json");
process.env.ASSIST_CONVERSATION_FILE = path.join(dir, "conversations.json");
process.env.ASSIST_KNOWLEDGE_FILE = path.join(dir, "knowledge.json");
process.env.ASSIST_TASKS_FILE = path.join(dir, "tasks-list.json");
process.env.ASSIST_FLOW_FILE = path.join(dir, "flow.json");
process.env.ASCEND_PREFERENCES_FILE = path.join(dir, "preferences.json");
process.env.TRHAI_LICENSE_FILE = path.join(dir, "license.json");
process.env.TRHAI_TRIAL_MARKER = path.join(dir, "elsewhere", "trial-started");
// TRH AI is free by default (licenseConfig.ts); these tests are about the paywall that can be switched back on.
process.env.TRHAI_PAYWALL = "on";
delete process.env.TRHAI_AUTHORITY;

const accounts = await import("../src/services/accounts.js");
const audit = await import("../src/services/audit.js");
const conversations = await import("../src/services/conversationStore.js");
const memory = await import("../src/services/assistMemoryStore.js");
const knowledge = await import("../src/services/knowledgeStore.js");
const todos = await import("../src/services/taskListStore.js");
const schedules = await import("../src/services/scheduleStore.js");
const flows = await import("../src/services/flowStore.js");
const mail = await import("../src/services/emailAccount.js");
const preferences = await import("../src/services/preferences.js");
const licensing = await import("../src/services/licensing.js");
const { encryptJson, readProtectedJsonFile, writeProtectedJsonFile } = await import("../src/services/protectedJson.js");
const { createApp } = await import("../src/server.js");
const { resetRateLimits } = await import("../src/services/rateLimit.js");

const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const password = "correct horse battery";
const day = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: any; text: string; headers: Headers };

async function call(method: string, route: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body, text, headers: response.headers };
}

function reset(): void {
  accounts.resetAccounts();
  audit.resetAuditForTests();
  resetRateLimits();
  conversations.resetConversations();
  memory.resetAssistMemory();
  knowledge.resetKnowledge();
  todos.resetTasks();
  schedules.resetSchedules();
  preferences.resetPreferences();
  flows.clearFlow();
  mail.removeEmailAccount();
  licensing.removeLicense();
  rmSync(requestsFile, { force: true });
  rmSync(`${accountsFile}.before-roles`, { force: true });
}

async function register(email: string, extra: Record<string, unknown> = {}): Promise<{ token: string; id: string; key: string }> {
  const reply = await call("POST", "/v1/auth/register", { body: { email, password, consents, ...extra } });
  assert.equal(reply.status, 201, reply.text);
  return { token: reply.body.data.token, id: reply.body.data.account.id, key: `user:${reply.body.data.account.id}` };
}

/** Something of every kind, kept under one key. */
function fillKey(key: string, mark: string): void {
  conversations.appendTurn(key, "user", `${mark}: what is on my calendar?`);
  conversations.appendTurn(key, "assistant", `${mark}: nothing today.`);
  memory.recordSingleMemory(key, `${mark} prefers tea over coffee`);
  const [first] = memory.listSessionMemories(key);
  assert.ok(first, "a memory was recorded");
  memory.forgetMemory(key, first.id);
  memory.recordSingleMemory(key, `${mark} lives in Lisbon`);
  knowledge.addDocument(key, { id: `doc-${mark}`, title: `${mark} runbook`, body: `${mark} the vault code is hidden` });
  todos.addTask(key, { id: `todo-${mark}`, title: `${mark} buy stamps` });
}

function held(key: string) {
  return {
    conversations: conversations.listConversations(key).length,
    memories: memory.listSessionMemories(key).length,
    forgotten: memory.listForgottenFacts(key).length,
    documents: knowledge.listDocuments(key).length,
    todos: todos.listTasks(key).length
  };
}

const typedWord = "ERASE";

// ---------------------------------------------------------------- consent at the door

test("an account cannot be made without agreeing to the Terms and reading the Privacy Policy", async () => {
  reset();
  const none = await call("POST", "/v1/auth/register", { body: { email: "a@example.com", password } });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, "CONSENT_REQUIRED");
  assert.match(none.body.message, /Terms of Service/);

  const onlyTerms = await call("POST", "/v1/auth/register", { body: { email: "a@example.com", password, consents: { terms: legalVersions.terms } } });
  assert.equal(onlyTerms.status, 400);
  assert.match(onlyTerms.body.message, /Privacy Policy/);

  const onlyPrivacy = await call("POST", "/v1/auth/register", { body: { email: "a@example.com", password, consents: { privacy: legalVersions.privacy } } });
  assert.equal(onlyPrivacy.status, 400);
  assert.match(onlyPrivacy.body.message, /Terms of Service/);

  const vague = await call("POST", "/v1/auth/register", { body: { email: "a@example.com", password, consents: { terms: true, privacy: true } } });
  assert.equal(vague.status, 400, "true is not a version: the words agreed to must be named");
  assert.match(vague.body.message, /Terms of Service/);
  assert.equal(accounts.listAccounts().total, 0, "nothing was made by any of these");
});

test("a page left open while a text changed cannot agree to words it never showed", async () => {
  reset();
  const stale = await call("POST", "/v1/auth/register", { body: { email: "a@example.com", password, consents: { ...consents, terms: "2020-01-01" } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "POLICY_VERSION_CHANGED");
  assert.match(stale.body.message, /Reload the page/);
  assert.equal(accounts.listAccounts().total, 0);
});

test("what was agreed to is kept with the account: which text, which version, when", async () => {
  reset();
  const before = Date.now();
  const person = await register("kept@example.com");
  const records = accounts.consentsOf(person.id);
  assert.deepEqual(records.map((record) => record.kind), ["terms", "privacy"], "no age confirmation while the owner has set no minimum age");
  assert.equal(records[0].version, legalVersions.terms);
  assert.equal(records[1].version, legalVersions.privacy);
  for (const record of records) {
    assert.equal(record.via, "registration");
    assert.equal(record.withdrawnAt, null);
    assert.ok(Date.parse(record.acceptedAt) >= before - 1000 && Date.parse(record.acceptedAt) <= Date.now() + 1000);
  }
  const summary = await call("GET", "/v1/privacy/summary", { token: person.token });
  assert.deepEqual(summary.body.data.consents.map((line: { upToDate: boolean }) => line.upToDate), [true, true]);
  // And they are in the encrypted accounts file, not readable from outside it.
  assert.doesNotMatch(readFileSync(accountsFile, "utf8"), new RegExp(legalVersions.terms));
});

test("a minimum age, once the owner sets one, must be confirmed and is kept", async () => {
  reset();
  legalFacts.minimumAge = 18;
  try {
    const without = await call("POST", "/v1/auth/register", { body: { email: "age@example.com", password, consents: { terms: legalVersions.terms, privacy: legalVersions.privacy } } });
    assert.equal(without.status, 400);
    assert.match(without.body.message, /at least 18/);
    const person = await register("age@example.com");
    const age = accounts.consentsOf(person.id).find((record) => record.kind === "age");
    assert.equal(age?.version, "18", "the age that was confirmed, not a text version");
  } finally {
    legalFacts.minimumAge = null;
  }
});

test("an account made before agreements were kept is asked, and agreeing is recorded; a stale version is refused", async () => {
  reset();
  const old = accounts.registerAccount({ email: "old@example.com", password });
  assert.ok(old.ok);
  assert.deepEqual(accounts.consentsOf(old.account.id), []);

  const summary = await call("GET", "/v1/privacy/summary", { token: old.token });
  assert.deepEqual(summary.body.data.consents.map((line: { upToDate: boolean }) => line.upToDate), [false, false]);

  const stale = await call("POST", "/v1/privacy/consents", { token: old.token, body: { consents: { terms: "2020-01-01", privacy: legalVersions.privacy } } });
  assert.equal(stale.status, 409);
  const missing = await call("POST", "/v1/privacy/consents", { token: old.token, body: { consents: { terms: legalVersions.terms } } });
  assert.equal(missing.status, 400, "the Privacy Policy is still to be read");
  const anonymous = await call("POST", "/v1/privacy/consents", { body: { consents } });
  assert.equal(anonymous.status, 401);

  const agreed = await call("POST", "/v1/privacy/consents", { token: old.token, body: { consents } });
  assert.equal(agreed.status, 200);
  assert.deepEqual(agreed.body.data.consents.map((line: { upToDate: boolean }) => line.upToDate), [true, true]);
  assert.deepEqual(accounts.consentsOf(old.account.id).map((record) => record.via), ["settings", "settings"]);
});

// ------------------------------------------------------------------- the copy

test("the copy holds everything kept for the person, and nobody else's", async () => {
  reset();
  const ada = await register("ada@example.com", { displayName: "Ada" });
  const bob = await register("bob@example.com");
  fillKey(ada.key, "ADA");
  fillKey(bob.key, "BOB");

  const reply = await call("GET", "/v1/privacy/export", { token: ada.token });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get("content-disposition") ?? "", /^attachment; filename="trh-ai-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  const copy = reply.body;
  assert.equal(copy.format, "trhai-personal-data/1");
  assert.equal(copy.account.email, "ada@example.com");
  assert.equal(copy.conversations.length, 1);
  assert.equal(copy.conversations[0].turns.length, 2);
  assert.equal(copy.memories.length, 1);
  assert.equal(copy.forgottenNotes.length, 1, "the note of what was forgotten is the person's data too");
  assert.equal(copy.documents.length, 1);
  assert.equal(copy.todos.length, 1);
  assert.deepEqual(copy.consents.map((record: { kind: string }) => record.kind), ["terms", "privacy"]);
  assert.ok(!reply.text.includes("BOB"), "another account's words are not in it");
  assert.ok(Array.isArray(copy.notIncluded) && copy.notIncluded.length >= 5, "what it leaves out is said in the file");
});

test("the copy never holds a password, a hash, a salt, a session token or a recovery code", async () => {
  reset();
  const ada = await register("ada@example.com");
  mail.saveEmailAccount({ address: "ada@example.com", password: "mail-app-password-xyz", host: "smtp.example.com", port: 587 });
  const reply = await call("GET", "/v1/privacy/export", { token: ada.token });
  assert.equal(reply.status, 200);
  const onDisk = JSON.stringify(readAccountsPlain());
  for (const secret of [password, "mail-app-password-xyz", ada.token, onDisk.match(/"hash":"([0-9a-f]+)"/)?.[1] ?? "no-hash-found", onDisk.match(/"salt":"([0-9a-f]+)"/)?.[1] ?? "no-salt-found"]) {
    assert.ok(!reply.text.includes(secret), `the copy must not contain ${secret.slice(0, 6)}...`);
  }
  assert.equal(reply.body.thisCopy.emailAccount.configured, true);
  assert.equal(reply.body.thisCopy.emailAccount.address, "ada@example.com");
  assert.ok(!("password" in reply.body.thisCopy.emailAccount));
});

test("a person with no account takes the copy of their session, and the whole copy of TRH AI on their own PC comes with it", async () => {
  reset();
  fillKey("guest-session-1", "GUEST");
  fillKey("guest-session-2", "OTHER");
  schedules.addSchedule({ id: "s1", name: "Water", action: { kind: "remind", text: "drink water" }, cadence: { kind: "interval", minutes: 60 } });
  const reply = await call("GET", "/v1/privacy/export?sessionId=guest-session-1");
  assert.equal(reply.status, 200);
  assert.equal(reply.body.account, null);
  assert.equal(reply.body.conversations.length, 1);
  assert.ok(!reply.text.includes("OTHER"));
  assert.equal(reply.body.thisCopy.schedules.length, 1, "on one's own PC the schedules are theirs");

  const nothing = await call("GET", "/v1/privacy/export");
  assert.equal(nothing.status, 400, "neither an account nor a session: nothing to copy");
  const impersonation = await call("GET", "/v1/privacy/export?sessionId=user:someone");
  assert.equal(impersonation.status, 400, "the signed-in namespace cannot be named without a sign-in");
});

test("on a copy other people share, only its owner is handed what is shared by everyone", async () => {
  reset();
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const owner = await register("owner@example.com");
    const member = await register("member@example.com");
    assert.ok(accounts.assignOwner(owner.id).ok);
    schedules.addSchedule({ id: "s1", name: "Water", action: { kind: "remind", text: "drink water" }, cadence: { kind: "interval", minutes: 60 } });
    const mine = await call("GET", "/v1/privacy/export", { token: member.token });
    assert.equal(mine.body.thisCopy, null, "a member is not handed the shared schedules");
    const theirs = await call("GET", "/v1/privacy/export", { token: owner.token });
    assert.equal(theirs.body.thisCopy.schedules.length, 1);
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("the copy and the erasure are available when the trial has ended", async () => {
  reset();
  const person = await register("late@example.com");
  fillKey(person.key, "LATE");
  writeProtectedJsonFile(path.join(dir, "license.json"), { trialStartedAt: new Date(Date.now() - (licensing.trialDays + 30) * day).toISOString() });
  licensing.resetLicensingForTests();
  assert.equal(licensing.licenseStatus().locked, true, "the trial really has ended");
  const locked = await call("POST", "/v1/assist", { token: person.token, body: { message: "hello" } });
  assert.equal(locked.status, 402, "so the assistant is locked");

  assert.equal((await call("GET", "/v1/privacy/export", { token: person.token })).status, 200);
  const erased = await call("POST", "/v1/privacy/erase", { token: person.token, body: { confirm: typedWord, password, scope: { ownData: true, account: true } } });
  assert.equal(erased.status, 200);
  assert.equal(erased.body.data.complete, true);
});

test("removing what you made is never locked by a lapsed trial, while making new things still is", async () => {
  reset();
  const person = await register("late@example.com");
  fillKey(person.key, "LATE");
  const [firstMemory] = memory.listSessionMemories(person.key);
  writeProtectedJsonFile(path.join(dir, "license.json"), { trialStartedAt: new Date(Date.now() - (licensing.trialDays + 30) * day).toISOString() });
  licensing.resetLicensingForTests();
  assert.equal(licensing.licenseStatus().locked, true);

  const adding = await call("POST", "/v1/tasks", { token: person.token, body: { title: "new thing" } });
  assert.equal(adding.status, 402, "making something new is what the lock is for");

  const forgetting = await call("DELETE", `/v1/assist/memory/${firstMemory.id}`, { token: person.token });
  assert.notEqual(forgetting.status, 402, "deleting a memory");
  assert.equal(memory.listSessionMemories(person.key).length, 0);
  const removing = await call("DELETE", "/v1/tasks/todo-LATE", { token: person.token });
  assert.notEqual(removing.status, 402, "deleting a to-do");
  assert.equal(todos.listTasks(person.key).length, 0);
});

// ------------------------------------------------------------------ erasure

test("erasing needs the typed word, a scope, and - when signed in - the person's own password", async () => {
  reset();
  const ada = await register("ada@example.com");
  fillKey(ada.key, "ADA");
  const before = held(ada.key);

  const noWord = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { password, scope: { ownData: true } } });
  assert.equal(noWord.status, 400);
  assert.equal(noWord.body.code, "CONFIRMATION_REQUIRED");
  const wrongWord = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: "yes", password, scope: { ownData: true } } });
  assert.equal(wrongWord.status, 400);
  const noScope = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: {} } });
  assert.equal(noScope.status, 400);
  const noPassword = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, scope: { ownData: true } } });
  assert.equal(noPassword.status, 403);
  assert.equal(noPassword.body.code, "PASSWORD_REQUIRED");
  const wrongPassword = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password: "not the password", scope: { ownData: true, account: true } } });
  assert.equal(wrongPassword.status, 403);

  assert.deepEqual(held(ada.key), before, "none of those erased anything");
  assert.ok(accounts.findAccount(ada.id), "nor did any of them end the account");
});

test("guessing the password at the erase route is slowed, like guessing it anywhere else", async () => {
  reset();
  const ada = await register("ada@example.com");
  const attempt = () => call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password: "guess guess guess", scope: { ownData: true } } });
  for (let index = 0; index < 5; index += 1) assert.equal((await attempt()).status, 403);
  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  const right = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { ownData: true } } });
  assert.equal(right.status, 429, "even the right password waits while the limit holds");
});

test("erasing a person's data removes it from every store - and from the note of what was forgotten - and leaves everyone else's", async () => {
  reset();
  const ada = await register("ada@example.com");
  const bob = await register("bob@example.com");
  fillKey(ada.key, "ADA");
  fillKey(bob.key, "BOB");
  assert.deepEqual(held(ada.key), { conversations: 1, memories: 1, forgotten: 1, documents: 1, todos: 1 });

  const reply = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { ownData: true } } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.complete, true);
  assert.equal(reply.body.data.removed.conversations, 1);
  assert.equal(reply.body.data.removed.memories, 1);
  assert.equal(reply.body.data.removed.forgottenNotes, 1);
  assert.equal(reply.body.data.removed.documents, 1);
  assert.equal(reply.body.data.removed.todos, 1);
  assert.deepEqual(held(ada.key), { conversations: 0, memories: 0, forgotten: 0, documents: 0, todos: 0 });
  assert.deepEqual(held(bob.key), { conversations: 1, memories: 1, forgotten: 1, documents: 1, todos: 1 }, "Bob's are untouched");
  assert.ok(accounts.findAccount(ada.id), "the account was not in the scope, so it stays");
  assert.ok(reply.body.data.kept.some((line: string) => /Your account, because you chose to keep it/.test(line)));

  // And it is gone from disk, not only from memory: a restart finds nothing.
  conversations.reloadConversationsFromDisk();
  memory.reloadAssistMemoryFromDisk();
  assert.equal(conversations.listConversations(ada.key).length, 0);
  assert.equal(memory.listSessionMemories(ada.key).length, 0);
  assert.equal(memory.listForgottenFacts(ada.key).length, 0);
  assert.ok(!readFileSync(process.env.ASSIST_MEMORY_FILE as string, "utf8").includes("Lisbon"), "nothing readable remains");
});

test("erasing the account removes the email, name, password hash, recovery codes, consents and every session; the person can no longer sign in", async () => {
  reset();
  const ada = await register("ada@example.com", { displayName: "Ada Lovelace" });
  const second = await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password } });
  assert.equal(second.status, 200);
  const bob = await register("bob@example.com");

  const reply = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { ownData: true, account: true } } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.complete, true);
  assert.equal(reply.body.data.signedOut, true);
  assert.equal(reply.body.data.removed.account, 1);

  assert.equal(accounts.findAccount(ada.id), null);
  assert.equal(accounts.accountForToken(ada.token), null, "the session that asked is over");
  assert.equal(accounts.accountForToken(second.body.data.token), null, "and so is every other");
  assert.equal((await call("POST", "/v1/auth/login", { body: { email: "ada@example.com", password } })).status, 401);
  assert.deepEqual(accounts.consentsOf(ada.id), []);
  assert.ok(accounts.findAccount(bob.id), "Bob is still there");
  assert.equal(accounts.accountForToken(bob.token)?.email, "bob@example.com");

  // Gone from the file, not hidden in it.
  accounts.reloadAccountsFromDisk();
  assert.equal(accounts.findAccount(ada.id), null);
  assert.equal(accounts.listAccounts().total, 1);
  const stored = JSON.stringify(readAccountsPlain());
  assert.ok(!stored.includes("ada@example.com") && !stored.includes("Ada Lovelace"));
});

test("the copy of the accounts file kept before an upgrade is cleaned too, and an unreadable one is left and said", async () => {
  reset();
  const ada = await register("ada@example.com");
  const bob = await register("bob@example.com");
  copyFileSync(accountsFile, `${accountsFile}.before-roles`);
  assert.ok(JSON.stringify(readAccountsPlain(`${accountsFile}.before-roles`)).includes("ada@example.com"), "the copy holds her");

  const reply = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { account: true } } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.complete, true);
  assert.equal(reply.body.data.removed.accountBackups, 1);
  const copy = JSON.stringify(readAccountsPlain(`${accountsFile}.before-roles`));
  assert.ok(!copy.includes("ada@example.com"), "she is not in the copy any more");
  assert.ok(copy.includes("bob@example.com"), "the copy keeps everyone else");

  // A copy written with another key cannot be read: it is left as it was, and the report says so.
  const carol = await register("carol@example.com");
  const sealed = encryptJson({ accounts: [] });
  sealed.tag = Buffer.alloc(16, 1).toString("base64");
  writeFileSync(`${accountsFile}.before-roles`, JSON.stringify(sealed));
  const unreadable = readFileSync(`${accountsFile}.before-roles`, "utf8");
  const odd = await call("POST", "/v1/privacy/erase", { token: carol.token, body: { confirm: typedWord, password, scope: { account: true } } });
  assert.equal(odd.status, 200);
  assert.equal(odd.body.data.complete, false);
  const step = odd.body.data.steps.find((entry: { step: string }) => entry.step === "account backup copies");
  assert.equal(step.ok, false);
  assert.match(step.detail, /could not be read/);
  assert.equal(accounts.findAccount(carol.id), null, "the account itself is gone all the same");
  assert.equal(readFileSync(`${accountsFile}.before-roles`, "utf8"), unreadable, "the copy was left exactly as it was");
  assert.ok(accounts.findAccount(bob.id));
});

test("a person with no account erases their session's data by the typed word alone, and cannot erase an account they do not have", async () => {
  reset();
  fillKey("guest-1", "GUEST");
  fillKey("guest-2", "OTHER");
  const noAccount = await call("POST", "/v1/privacy/erase", { body: { sessionId: "guest-1", confirm: typedWord, scope: { account: true } } });
  assert.equal(noAccount.status, 400);
  assert.deepEqual(held("guest-1"), { conversations: 1, memories: 1, forgotten: 1, documents: 1, todos: 1 });

  const reply = await call("POST", "/v1/privacy/erase", { body: { sessionId: "guest-1", confirm: typedWord, scope: { ownData: true } } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.complete, true);
  assert.deepEqual(held("guest-1"), { conversations: 0, memories: 0, forgotten: 0, documents: 0, todos: 0 });
  assert.deepEqual(held("guest-2"), { conversations: 1, memories: 1, forgotten: 1, documents: 1, todos: 1 });

  const nobody = await call("POST", "/v1/privacy/erase", { body: { confirm: typedWord, scope: { ownData: true } } });
  assert.equal(nobody.status, 400, "no account and no session: nothing to erase");
});

test("on one's own PC the person may also erase what the copy holds that is not under their key, and the license only if they say so", async () => {
  reset();
  const ada = await register("ada@example.com");
  schedules.addSchedule({ id: "s1", name: "Water", action: { kind: "remind", text: "drink water" }, cadence: { kind: "interval", minutes: 60 } });
  flows.saveFlow({ id: "f1", name: "My flow", nodes: [{ id: "n1", kind: "check", label: "Disk", config: {} }] });
  preferences.updatePreferences({ voice: "en_GB-alan-medium" } as never);
  mail.saveEmailAccount({ address: "ada@example.com", password: "mail-pass", host: "smtp.example.com", port: 587 });
  assert.equal(schedules.listSchedules().length, 1);
  assert.equal(mail.describeEmailAccount().configured, true);

  const kept = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { wholeCopy: true } } });
  assert.equal(kept.status, 200);
  assert.equal(schedules.listSchedules().length, 0);
  assert.equal(flows.getFlow(), null);
  assert.equal(mail.describeEmailAccount().configured, false);
  assert.equal(kept.body.data.removed.schedules, 1);
  assert.equal(kept.body.data.removed.emailAccount, 1);
  // This PC holds no key, so none is said to be kept. (free-edition.test.ts has the case where it does.)
  assert.ok(kept.body.data.kept.every((line: string) => !/key on this PC/.test(line)), "no key is named on a PC that has none");
});

test("on a copy other people share, a member cannot erase what is shared, and the owner cannot erase the owner account", async () => {
  reset();
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const owner = await register("owner@example.com");
    const member = await register("member@example.com");
    assert.ok(accounts.assignOwner(owner.id).ok);
    schedules.addSchedule({ id: "s1", name: "Water", action: { kind: "remind", text: "drink water" }, cadence: { kind: "interval", minutes: 60 } });

    const refused = await call("POST", "/v1/privacy/erase", { token: member.token, body: { confirm: typedWord, password, scope: { wholeCopy: true } } });
    assert.equal(refused.status, 403);
    assert.equal(schedules.listSchedules().length, 1, "the schedules are everyone's, not the member's");

    const ownAccount = await call("POST", "/v1/privacy/erase", { token: member.token, body: { confirm: typedWord, password, scope: { ownData: true, account: true } } });
    assert.equal(ownAccount.status, 200, "a member may always erase their own");
    assert.equal(accounts.findAccount(member.id), null);

    const ownerLeaving = await call("POST", "/v1/privacy/erase", { token: owner.token, body: { confirm: typedWord, password, scope: { account: true } } });
    assert.equal(ownerLeaving.status, 409);
    assert.equal(ownerLeaving.body.code, "OWNER_ACCOUNT");
    assert.ok(accounts.findAccount(owner.id), "the service is not left without an owner");
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("on a copy other people share, erasing an account takes the address out of the record of changes, which still verifies, and says it did", async () => {
  reset();
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const owner = await register("owner@example.com");
    const member = await register("member@example.com");
    assert.ok(accounts.assignOwner(owner.id).ok);
    audit.recordAudit({ actor: { kind: "account", id: owner.id, email: "owner@example.com", role: "owner" }, action: "account.suspended", target: { id: member.id, email: "member@example.com" } });
    audit.recordAudit({ actor: { kind: "account", id: owner.id, email: "owner@example.com", role: "owner" }, action: "account.reactivated", target: { id: member.id, email: "member@example.com" } });
    assert.equal(audit.verifyAuditChain().ok, true);

    const reply = await call("POST", "/v1/privacy/erase", { token: member.token, body: { confirm: typedWord, password, scope: { account: true } } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.complete, true);
    assert.equal(reply.body.data.removed.auditEntries, 2);

    const record = audit.listAudit({ limit: 50 }).entries;
    assert.ok(!JSON.stringify(record).includes("member@example.com"), "the address is gone from the record");
    assert.ok(JSON.stringify(record).includes("owner@example.com"), "everyone else's stays");
    assert.equal(audit.verifyAuditChain().ok, true, "and the record still checks out");
    const last = record[0];
    assert.equal(last.action, "account.erased");
    assert.match(last.detail, /taken out of 2 earlier entries/);
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

test("a record of changes that fails its own check is not edited to hide that, and the report says so", async () => {
  reset();
  process.env.TRHAI_AUTHORITY = "on";
  try {
    const owner = await register("owner@example.com");
    const member = await register("member@example.com");
    assert.ok(accounts.assignOwner(owner.id).ok);
    audit.recordAudit({ actor: { kind: "account", id: owner.id, email: "owner@example.com", role: "owner" }, action: "account.suspended", target: { id: member.id, email: "member@example.com" } });
    audit.recordAudit({ actor: { kind: "account", id: owner.id, email: "owner@example.com", role: "owner" }, action: "account.reactivated", target: { id: member.id, email: "member@example.com" } });
    audit.auditEntriesForTests()[0].detail = "quietly changed";
    assert.equal(audit.verifyAuditChain().ok, false);

    const reply = await call("POST", "/v1/privacy/erase", { token: member.token, body: { confirm: typedWord, password, scope: { account: true } } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.complete, false);
    const step = reply.body.data.steps.find((entry: { step: string }) => entry.step === "audit record");
    assert.equal(step.ok, false);
    assert.match(step.detail, /fails its own check/);
    assert.equal(accounts.findAccount(member.id), null, "the account itself is gone");
    assert.equal(audit.verifyAuditChain().ok, false, "the record was not re-bound over the damage");
  } finally {
    delete process.env.TRHAI_AUTHORITY;
  }
});

// ------------------------------------------------------------------ the record

test("that an erasure was asked for and done is recorded without a name or an email, and old records are dropped", async () => {
  reset();
  const old = { id: "old-one", at: new Date(Date.now() - 800 * day).toISOString(), kind: "erasure", accountRef: null, scope: ["account"], complete: true, removed: {} };
  const recent = { id: "recent-one", at: new Date(Date.now() - 100 * day).toISOString(), kind: "erasure", accountRef: null, scope: ["account"], complete: true, removed: {} };
  writeProtectedJsonFile(requestsFile, { version: 1, requests: [old, recent] });

  const ada = await register("ada@example.com", { displayName: "Ada Lovelace" });
  fillKey(ada.key, "ADA");
  const reply = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { ownData: true, account: true } } });
  assert.equal(reply.status, 200);

  const kept = (readProtectedJsonFile(requestsFile) as { requests: Array<{ id: string; accountRef: string | null; scope: string[]; complete: boolean }> }).requests;
  assert.deepEqual(kept.map((entry) => entry.id).filter((id) => id.endsWith("-one")), ["recent-one"], "the record older than twenty-four months is gone");
  const mine = kept.find((entry) => entry.accountRef === ada.id);
  assert.ok(mine, "this request is recorded");
  assert.equal(mine.complete, true);
  assert.deepEqual(mine.scope, ["conversations, memories, documents, to-dos and task history", "account"]);
  const text = JSON.stringify(kept);
  assert.ok(!text.includes("ada@example.com") && !text.includes("Ada Lovelace") && !text.includes("ADA"), "no name, email or content in the record");
});

test("every erasure says what it left, so nothing is a surprise", async () => {
  reset();
  const ada = await register("ada@example.com");
  const reply = await call("POST", "/v1/privacy/erase", { token: ada.token, body: { confirm: typedWord, password, scope: { ownData: true, account: true } } });
  const kept: string[] = reply.body.data.kept;
  assert.ok(kept.some((line) => /workspace folder/.test(line) && /do not delete/i.test(line) || /does not delete them/.test(line)), "the files in the workspace");
  assert.ok(kept.some((line) => /free trial began/.test(line)), "the trial marker");
  assert.ok(kept.some((line) => /downloaded/.test(line)), "the downloaded software");
  assert.ok(kept.some((line) => /short record that this request was made/.test(line) && /24 months/.test(line)), "the record of the request");
});

test("the summary says how much of each kind is held, so the screen can say exactly what an erasure would remove", async () => {
  reset();
  const ada = await register("ada@example.com");
  fillKey(ada.key, "ADA");
  const reply = await call("GET", "/v1/privacy/summary", { token: ada.token });
  assert.equal(reply.status, 200);
  const data = reply.body.data;
  assert.deepEqual({ conversations: data.held.conversations, memories: data.held.memories, documents: data.held.documents, todos: data.held.todos }, { conversations: 1, memories: 1, documents: 1, todos: 1 });
  assert.equal(data.wholeCopyAllowed, true);
  assert.equal(data.sharedCopy, false);
  assert.equal(data.signedIn, true);
  assert.equal(data.texts.versions.privacy, legalVersions.privacy);
  assert.equal(data.texts.status, "draft");
  assert.equal(data.requestRecordMonths, 24);
  assert.ok(existsSync(accountsFile));
});

// A plain (decrypted) reading of the accounts file, for asserting what is and is not in it.
function readAccountsPlain(file: string = accountsFile): unknown {
  return readProtectedJsonFile(file);
}
