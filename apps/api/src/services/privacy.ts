import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { legalFacts, legalVersions } from "@ascend/shared";
import { authorityMode } from "./access.js";
import {
  accountsBackupCopies, consentsOf, eraseAccountRecord, recordConsents, scrubAccountFromFile,
  type Account, type ConsentKind, type ConsentRecord
} from "./accounts.js";
import { redactAuditSubject } from "./audit.js";
import { eraseConversations, getConversation, listConversations, type StoredTurn } from "./conversationStore.js";
import { dataFile } from "./dataDirectory.js";
import { describeEmailAccount, removeEmailAccount } from "./emailAccount.js";
import { clearEvents } from "./executionLog.js";
import { clearFlow, getFlow } from "./flowStore.js";
import { eraseSessionMemory, listForgottenFacts, listSessionMemories } from "./assistMemoryStore.js";
import { listDocuments, resetKnowledge } from "./knowledgeStore.js";
import { licenseStatus, removeLicense } from "./licensing.js";
import { readPreferences, resetPreferences } from "./preferences.js";
import { assertProtectedJsonWritable, readProtectedJsonFile, writeProtectedJsonFile } from "./protectedJson.js";
import { listSchedules, resetSchedules } from "./scheduleStore.js";
import { clearTask, getTask } from "./taskStore.js";
import { clearFinishedTasks, listFinishedTasks } from "./taskHistory.js";
import { listTasks, resetTasks } from "./taskListStore.js";
import { workspaceRoot } from "./workspace.js";

// What a person agreed to, what they can take with them, and how they leave.
//
// Three things live here, and they share one rule: say only what is true, and do
// only what was asked, in full.
//
//   1. Consent at the door. Making an account takes an agreement to the Terms and
//      an acknowledgment of the Privacy Policy (and, once the owner sets a minimum
//      age, a confirmation of it). Each is kept with the account as the version of
//      the text that was shown and the moment it was given.
//   2. A copy of the data. One JSON document with everything TRH AI holds for the
//      person, in words they can read - and a plain list of what it leaves out.
//   3. Erasure. Not a suspension and not a flag: the records are removed, the
//      copies the service keeps of them are removed, and what is left is said.
//
// Whose data is whose follows how the stores already work: conversations, memories,
// documents, to-dos and task history are kept under a key - `user:<account id>`
// when signed in, the anonymous session id otherwise - so those belong to the
// person. Schedules, the automation flow, preferences, the saved email account and
// the license belong to the copy of TRH AI they sit on. On someone's own PC the
// person is that copy's only user, so erasing it is theirs to do; on a copy that
// other people sign in to, only its owner may.

// ------------------------------------------------------------- consent at the door

const consentLabels: Record<ConsentKind, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
  age: "age confirmation"
};

/** The consents the current texts ask for. The age one only once the owner has set a minimum age. */
export function requiredConsentKinds(): ConsentKind[] {
  return legalFacts.minimumAge === null ? ["terms", "privacy"] : ["terms", "privacy", "age"];
}

/** The version a consent of this kind names today: a text's date, or the minimum age confirmed. */
function currentVersion(kind: ConsentKind): string {
  return kind === "age" ? String(legalFacts.minimumAge) : legalVersions[kind];
}

export type ConsentRefusal = { ok: false; status: 400 | 409; code: "CONSENT_REQUIRED" | "POLICY_VERSION_CHANGED"; message: string };

function needed(kind: ConsentKind): ConsentRefusal {
  const message = kind === "terms" ? "Agreeing to the Terms of Service is required to make an account."
    : kind === "privacy" ? "Confirming you have read the Privacy Policy is required to make an account."
      : `Confirming that you are at least ${legalFacts.minimumAge} years old is required to make an account.`;
  return { ok: false, status: 400, code: "CONSENT_REQUIRED", message };
}

function changed(kind: ConsentKind): ConsentRefusal {
  return {
    ok: false, status: 409, code: "POLICY_VERSION_CHANGED",
    message: `The ${consentLabels[kind]} changed while this page was open. Reload the page and read the new one before agreeing.`
  };
}

/**
 * The consents a request to make an account carries, as records, or why it does not.
 *
 * The texts are named by version, so a page left open while a text changed cannot
 * agree to words it never showed: that is answered 409, and the person reads again.
 */
export function registrationConsents(raw: unknown, at: Date = new Date()): { ok: true; records: ConsentRecord[] } | ConsentRefusal {
  const given = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const records: ConsentRecord[] = [];
  for (const kind of requiredConsentKinds()) {
    const value = given[kind];
    if (kind === "age") {
      if (value !== true) return needed(kind);
    } else if (typeof value !== "string" || !value) {
      return needed(kind);
    } else if (value !== legalVersions[kind]) {
      return changed(kind);
    }
    records.push({ kind, version: currentVersion(kind), acceptedAt: at.toISOString(), via: "registration", withdrawnAt: null });
  }
  return { ok: true, records };
}

export type ConsentLine = {
  kind: ConsentKind;
  label: string;
  /** The version the current text carries. */
  current: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  via: ConsentRecord["via"] | null;
  /** Whether what was agreed to is the text as it stands. */
  upToDate: boolean;
};

/** Where an account stands on each text it is asked to agree to. */
export function consentStatus(accountId: string): ConsentLine[] {
  const records = consentsOf(accountId);
  return requiredConsentKinds().map((kind) => {
    const latest = [...records].reverse().find((record) => record.kind === kind && !record.withdrawnAt) ?? null;
    return {
      kind,
      label: consentLabels[kind],
      current: currentVersion(kind),
      acceptedVersion: latest?.version ?? null,
      acceptedAt: latest?.acceptedAt ?? null,
      via: latest?.via ?? null,
      upToDate: latest?.version === currentVersion(kind)
    };
  });
}

/**
 * Records that a signed-in person has now agreed to the texts as they stand - after
 * a text changed, or for an account made before consents were kept. Each text is
 * named by the version the person was shown.
 */
export function acceptCurrentTexts(
  accountId: string, raw: unknown, via: ConsentRecord["via"], at: Date = new Date()
): { ok: true; lines: ConsentLine[] } | ConsentRefusal {
  const given = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const records: ConsentRecord[] = [];
  for (const kind of requiredConsentKinds()) {
    const value = given[kind];
    if (kind === "age" ? value !== true : typeof value !== "string" || !value) {
      // Only what is up to date may be left out: a text still to be agreed to is asked for.
      if (consentStatus(accountId).find((line) => line.kind === kind)?.upToDate) continue;
      return needed(kind);
    }
    if (kind !== "age" && value !== legalVersions[kind]) return changed(kind);
    records.push({ kind, version: currentVersion(kind), acceptedAt: at.toISOString(), via, withdrawnAt: null });
  }
  if (records.length > 0 && recordConsents(accountId, records) === null) {
    return { ok: false, status: 400, code: "CONSENT_REQUIRED", message: "That account no longer exists." };
  }
  return { ok: true, lines: consentStatus(accountId) };
}

// ------------------------------------------------------------------- whose data

/** Whose data a request is about: the key it is kept under, and the account behind it when signed in. */
export type Subject = { key: string; account: Account | null };

/**
 * Whether the person may deal with everything this copy of TRH AI holds that is not
 * kept under their own key (schedules, the flow, preferences, the saved email account,
 * the license). On their own PC they may: it is theirs and nobody else's. On a copy
 * that other people sign in to, only the owner may.
 */
export function mayHandleWholeCopy(role: "owner" | "admin" | "user"): boolean {
  return !authorityMode() || role === "owner";
}

// ------------------------------------------------------------------- the copy

export type ExportedConversation = {
  id: string; title: string; createdAt: string; updatedAt: string; pinned: boolean; archived: boolean; model?: string; turns: StoredTurn[];
};

export type PersonalDataExport = {
  format: "trhai-personal-data/1";
  exportedAt: string;
  product: string;
  about: string;
  account: { id: string; email: string; displayName: string; createdAt: string; status: string; lastLoginAt: string | null } | null;
  consents: ConsentRecord[];
  conversations: ExportedConversation[];
  memories: ReturnType<typeof listSessionMemories>;
  forgottenNotes: string[];
  documents: ReturnType<typeof listDocuments>;
  todos: ReturnType<typeof listTasks>;
  currentWork: ReturnType<typeof getTask>;
  finishedWork: ReturnType<typeof listFinishedTasks>;
  /** What the copy of TRH AI holds that is not kept under a person's key; present only where it is theirs to take. */
  thisCopy: null | {
    schedules: ReturnType<typeof listSchedules>;
    automationFlow: ReturnType<typeof getFlow>;
    preferences: ReturnType<typeof readPreferences>;
    emailAccount: ReturnType<typeof describeEmailAccount>;
    license: ReturnType<typeof licenseStatus>["license"];
  };
  notIncluded: string[];
};

/** What an export leaves out, and why - said in the export itself, so nobody has to guess. */
export const notInExport: string[] = [
  "Passwords. TRH AI keeps only a one-way hash of your password, which cannot be turned back into it.",
  "Recovery codes and sign-in session tokens, for the same reason: only hashes of them are kept.",
  "The password of a saved email account. The address, server and port are included; the password is never put in a file.",
  "The key that encrypts TRH AI's files on this PC.",
  "Your files in the workspace folder. They are your own files, in a folder you can open; TRH AI does not copy or delete them.",
  "The engine, models and voices. They are software that was downloaded, not information about you.",
  "Display choices kept in the browser, such as the accent colour. They are shown under Settings, Privacy and consent, and removed there."
];

export function buildExport(subject: Subject, options: { wholeCopy: boolean }, at: Date = new Date()): PersonalDataExport {
  const { key, account } = subject;
  const summaries = [...listConversations(key), ...listConversations(key, { archived: true })];
  const conversations = summaries
    .map((summary) => getConversation(key, summary.id))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map((entry) => ({
      id: entry.id, title: entry.title, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      pinned: entry.pinned, archived: entry.archived, ...(entry.model ? { model: entry.model } : {}), turns: entry.turns
    }));

  return {
    format: "trhai-personal-data/1",
    exportedAt: at.toISOString(),
    product: "TRH AI",
    about: "A copy of what this copy of TRH AI holds for you, written when you asked for it. Nothing in it was sent anywhere. "
      + "The last list in this file, notIncluded, says what is left out and why.",
    account: account
      ? { id: account.id, email: account.email, displayName: account.displayName, createdAt: account.createdAt, status: account.status, lastLoginAt: account.lastLoginAt }
      : null,
    consents: account ? consentsOf(account.id) : [],
    conversations,
    memories: listSessionMemories(key),
    forgottenNotes: listForgottenFacts(key),
    documents: listDocuments(key),
    todos: listTasks(key),
    currentWork: getTask(key),
    finishedWork: listFinishedTasks(key),
    thisCopy: options.wholeCopy
      ? {
        schedules: listSchedules(),
        automationFlow: getFlow(),
        preferences: readPreferences(),
        emailAccount: describeEmailAccount(),
        license: licenseStatus().license
      }
      : null,
    notIncluded: notInExport
  };
}

export type HeldCounts = {
  conversations: number;
  memories: number;
  documents: number;
  todos: number;
  finishedWork: number;
  /** Only where the person may deal with the whole copy; otherwise null. */
  thisCopy: null | { schedules: number; automationFlow: boolean; emailAccount: boolean; license: boolean };
};

/** How much of each kind TRH AI holds for the person, so the screen can say exactly what an erasure would remove. */
export function heldBy(subject: Subject, options: { wholeCopy: boolean }): HeldCounts {
  const { key } = subject;
  return {
    conversations: listConversations(key).length + listConversations(key, { archived: true }).length,
    memories: listSessionMemories(key).length,
    documents: listDocuments(key).length,
    todos: listTasks(key).length,
    finishedWork: listFinishedTasks(key).length,
    thisCopy: options.wholeCopy
      ? {
        schedules: listSchedules().length,
        automationFlow: getFlow() !== null,
        emailAccount: describeEmailAccount().configured,
        license: licenseStatus().license !== null
      }
      : null
  };
}

// ------------------------------------------------------------------- the record

const requestsFile = process.env.ASSIST_PRIVACY_REQUESTS_FILE ?? dataFile("privacy-requests.json");
/** How long the record that an erasure was asked for and done is kept. It holds no name and no email. Subject to legal review. */
export const requestRecordMonths = 24;

export type PrivacyRequestRecord = {
  id: string;
  at: string;
  kind: "erasure";
  /** The random id the account had, which identifies no one once the account is gone. Null for no account. */
  accountRef: string | null;
  scope: string[];
  complete: boolean;
  removed: Record<string, number>;
};

function readRequests(): PrivacyRequestRecord[] {
  if (!existsSync(requestsFile)) return [];
  try {
    const parsed = readProtectedJsonFile(requestsFile) as { requests?: PrivacyRequestRecord[] };
    return Array.isArray(parsed.requests) ? parsed.requests : [];
  } catch {
    return [];
  }
}

function writeRequests(requests: PrivacyRequestRecord[]): void {
  try {
    mkdirSync(path.dirname(requestsFile), { recursive: true });
    const temp = `${requestsFile}.tmp`;
    assertProtectedJsonWritable(requestsFile);
    writeProtectedJsonFile(temp, { version: 1, requests });
    renameSync(temp, requestsFile);
  } catch {
    // The erasure itself has been done; failing to note it must not undo or hide that.
  }
}

/** The record of erasures carried out, newest last, with those older than the retention period dropped. */
export function listPrivacyRequests(now: Date = new Date()): PrivacyRequestRecord[] {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - requestRecordMonths);
  return readRequests().filter((entry) => Date.parse(entry.at) >= cutoff.getTime());
}

// ------------------------------------------------------------------- erasure

export type EraseScope = {
  /** Conversations, memories, documents, to-dos and task history kept under the person's key. */
  ownData: boolean;
  /** Schedules, the automation flow, preferences and the saved email account. */
  wholeCopy: boolean;
  /** The license key on this PC. The trial clock is not touched. */
  license: boolean;
  /** The account itself: email, name, password hash, recovery codes, consents, sessions. */
  account: boolean;
};

export type EraseStep = { step: string; ok: boolean; detail: string };

export type EraseReport = {
  requestId: string;
  at: string;
  /** True when everything asked for was done. When it is false the account is left, so the request can be made again. */
  complete: boolean;
  removed: Record<string, number>;
  steps: EraseStep[];
  /** What was not removed, and why - always said, never left for the person to find out. */
  kept: string[];
};

export function describeScope(scope: EraseScope): string[] {
  const parts: string[] = [];
  if (scope.ownData) parts.push("conversations, memories, documents, to-dos and task history");
  if (scope.wholeCopy) parts.push("schedules, automation flow, preferences and saved email account");
  if (scope.license) parts.push("license key");
  if (scope.account) parts.push("account");
  return parts;
}

/**
 * Removes what was asked for, in full, and reports exactly what happened.
 *
 * The person's own data goes first and the account last: if a step fails the account
 * is left, so the request can be made again, rather than the data being left behind
 * with nothing to sign in to. Nothing is hidden or flagged inactive - each store
 * drops the records and writes the file again - and the copy of the accounts file
 * kept from before an upgrade is cleaned too.
 */
export function eraseSubject(subject: Subject, scope: EraseScope, at: Date = new Date()): EraseReport {
  const { key, account } = subject;
  const removed: Record<string, number> = {};
  const steps: EraseStep[] = [];
  const attempt = (step: string, run: () => string): boolean => {
    try {
      steps.push({ step, ok: true, detail: run() });
      return true;
    } catch (error) {
      steps.push({ step, ok: false, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  if (scope.ownData) {
    attempt("conversations", () => { removed.conversations = eraseConversations(key); return `${removed.conversations} removed`; });
    attempt("memories", () => {
      const result = eraseSessionMemory(key);
      removed.memories = result.memories;
      removed.forgottenNotes = result.forgotten;
      removed.memoryRecords = result.audit;
      return `${result.memories} memories, ${result.forgotten} notes of what was forgotten, ${result.audit} records of changes`;
    });
    attempt("documents", () => { removed.documents = listDocuments(key).length; resetKnowledge(key); return `${removed.documents} removed`; });
    attempt("to-dos", () => { removed.todos = listTasks(key).length; resetTasks(key); return `${removed.todos} removed`; });
    attempt("current work", () => { removed.currentWork = clearTask(key) ? 1 : 0; return removed.currentWork ? "removed" : "none"; });
    attempt("finished work", () => { removed.finishedWork = clearFinishedTasks(key); return `${removed.finishedWork} removed`; });
    attempt("run trace", () => { clearEvents(key); return "cleared"; });
  }

  if (scope.wholeCopy) {
    attempt("schedules", () => { removed.schedules = listSchedules().length; resetSchedules(); return `${removed.schedules} removed, with their run history`; });
    attempt("automation flow", () => { removed.automationFlow = clearFlow() ? 1 : 0; return removed.automationFlow ? "removed" : "none saved"; });
    attempt("preferences", () => { resetPreferences(); removed.preferences = 1; return "set back to their defaults"; });
    attempt("email account", () => { removed.emailAccount = removeEmailAccount() ? 1 : 0; return removed.emailAccount ? "removed, with its password" : "none saved"; });
  }

  if (scope.license) {
    attempt("license key", () => {
      const had = licenseStatus().license !== null;
      removeLicense();
      removed.license = had ? 1 : 0;
      return had ? "removed from this PC" : "none on this PC";
    });
  }

  const beforeAccount = steps.every((step) => step.ok);
  if (scope.account && account && beforeAccount) {
    attempt("account", () => {
      if (!eraseAccountRecord(account.id)) throw new Error("the account was already gone");
      removed.account = 1;
      return "removed, with its sessions, recovery codes and consents";
    });
    attempt("account backup copies", () => {
      let cleaned = 0;
      for (const copy of accountsBackupCopies()) {
        const result = scrubAccountFromFile(copy, account.id);
        if (result === "removed") cleaned += 1;
        if (result === "unreadable") throw new Error(`the copy at ${copy} could not be read, so it was left; delete it by hand`);
      }
      removed.accountBackups = cleaned;
      return cleaned > 0 ? `${cleaned} copy cleaned` : "no copy held it";
    });
    if (authorityMode()) {
      attempt("audit record", () => {
        const result = redactAuditSubject(account.id, at);
        if (!result.ok) throw new Error(result.reason);
        removed.auditEntries = result.redacted;
        return `the address was taken out of ${result.redacted} entr${result.redacted === 1 ? "y" : "ies"}`;
      });
    }
  }

  const requestId = randomUUID();
  const complete = steps.every((step) => step.ok) && (!scope.account || account === null || removed.account === 1);
  const record: PrivacyRequestRecord = {
    id: requestId,
    at: at.toISOString(),
    kind: "erasure",
    accountRef: scope.account && account ? account.id : null,
    scope: describeScope(scope),
    complete,
    removed
  };
  writeRequests([...listPrivacyRequests(at), record]);

  return { requestId, at: at.toISOString(), complete, removed, steps, kept: keptAfter(scope, account !== null) };
}

/** What an erasure leaves, said every time. */
function keptAfter(scope: EraseScope, hadAccount: boolean): string[] {
  const kept = [
    `Your files in the workspace folder (${workspaceRoot()}). They are your own files; TRH AI does not delete them.`,
    "The date this PC's free trial began. It stops the trial being restarted by deleting data, and holds no personal information.",
    "The engine, models and voices that were downloaded. They are software, not information about you.",
    `A short record that this request was made and carried out: its date, what it covered and a random id. It has no name or email, and is deleted after ${requestRecordMonths} months.`
  ];
  if (!scope.ownData) kept.push("Your conversations, memories, documents, to-dos and task history, because you chose to keep them.");
  if (!scope.wholeCopy) kept.push("This copy's schedules, automation flow, preferences and saved email account, because you chose to keep them.");
  if (!scope.license) kept.push("The license key on this PC, because you chose to keep it. It carries the email address it was bought with.");
  if (hadAccount && !scope.account) kept.push("Your account, because you chose to keep it.");
  return kept;
}
