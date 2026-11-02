import { legalFacts, legalVersions } from "@ascend/shared";
import { apiBaseUrl, apiFetch, apiGet, apiPost, requestHeaders, sessionId, type ApiResult } from "./api";

// What a person agreed to, the copy of their data, and erasing it - the client's side.
//
// The service decides everything that matters (apps/api/src/services/privacy.ts); this
// builds the requests, reads the answers, and keeps the few rules the screens share:
// which boxes a registration form shows, what it sends, and the word that confirms an
// erasure.

/** The word typed to confirm an erasure. The service checks it again. */
export const eraseWord = "ERASE";

export type ConsentTick = "terms" | "privacy" | "age";

/** The boxes a registration form shows: the Terms, the Privacy Policy, and - once a minimum age is set - the age. */
export function registrationTicks(): ConsentTick[] {
  return legalFacts.minimumAge === null ? ["terms", "privacy"] : ["terms", "privacy", "age"];
}

/** The sentence beside each box. Each box says one thing, so each can be agreed to or not on its own. */
export function tickWording(tick: ConsentTick): { before: string; link: "terms" | "privacy" | null; after: string } {
  if (tick === "terms") return { before: "I have read and agree to the ", link: "terms", after: "." };
  if (tick === "privacy") return { before: "I have read the ", link: "privacy", after: ", which says what TRH AI stores and what leaves this PC." };
  return { before: `I am at least ${legalFacts.minimumAge} years old.`, link: null, after: "" };
}

/**
 * What a request to make an account carries as its agreement: the texts by the version
 * the person was shown. Null until every box that is shown has been ticked - the request
 * is not made on a partial agreement.
 */
export function registrationConsentBody(ticked: Partial<Record<ConsentTick, boolean>>): Record<string, unknown> | null {
  const needed = registrationTicks();
  if (!needed.every((tick) => ticked[tick] === true)) return null;
  return {
    terms: legalVersions.terms,
    privacy: legalVersions.privacy,
    ...(needed.includes("age") ? { age: true } : {})
  };
}

// ------------------------------------------------------------------ what the service says

export type ConsentLine = {
  kind: ConsentTick;
  label: string;
  current: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  via: "registration" | "settings" | "prompt" | null;
  upToDate: boolean;
};

export type HeldCounts = {
  conversations: number;
  memories: number;
  documents: number;
  todos: number;
  finishedWork: number;
  thisCopy: null | { schedules: number; automationFlow: boolean; emailAccount: boolean; license: boolean };
};

export type PrivacySummary = {
  texts: { status: "draft" | "reviewed"; effectiveDate: string; versions: Record<string, string> };
  minimumAge: number | null;
  signedIn: boolean;
  sharedCopy: boolean;
  consents: ConsentLine[];
  wholeCopyAllowed: boolean;
  held: HeldCounts | null;
  requestRecordMonths: number;
};

export type EraseScope = { ownData: boolean; wholeCopy: boolean; license: boolean; account: boolean };

export type EraseReport = {
  requestId: string;
  at: string;
  complete: boolean;
  removed: Record<string, number>;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  kept: string[];
  signedOut: boolean;
};

export function fetchPrivacySummary(): Promise<ApiResult<PrivacySummary>> {
  return apiGet<PrivacySummary>(`/v1/privacy/summary?sessionId=${encodeURIComponent(sessionId())}`);
}

/** Agrees, for a signed-in person, to the texts as they stand. */
export function acceptTexts(): Promise<ApiResult<{ consents: ConsentLine[] }>> {
  return apiPost<{ consents: ConsentLine[] }>("/v1/privacy/consents", { consents: registrationConsentBody(Object.fromEntries(registrationTicks().map((tick) => [tick, true]))) });
}

export type ExportResult = { ok: true; filename: string; text: string } | { ok: false; reason: string };

/** The copy of the person's data, as the text of the file and the name it should be saved under. */
export async function requestExport(): Promise<ExportResult> {
  try {
    const response = await apiFetch(`${apiBaseUrl}/v1/privacy/export?sessionId=${encodeURIComponent(sessionId())}`, { headers: requestHeaders() });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { message?: unknown } | null;
      return { ok: false, reason: typeof payload?.message === "string" ? payload.message : `The service answered with ${response.status}.` };
    }
    const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
    return { ok: true, filename: named ?? "trh-ai-my-data.json", text: await response.text() };
  } catch {
    return { ok: false, reason: "Could not reach the local service." };
  }
}

/** Saves text as a file the person chooses where to keep, through the browser's own download. */
export function saveTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function requestErase(input: { password: string; confirm: string; scope: EraseScope }): Promise<ApiResult<EraseReport>> {
  return apiPost<EraseReport>("/v1/privacy/erase", { ...input, sessionId: sessionId() });
}

/**
 * What the person is told they are about to erase, in words, from what the service says is held and what they
 * ticked. Said in full before the button is pressed, so the confirmation is to something specific.
 */
export function describeErasure(held: HeldCounts | null, scope: EraseScope): string[] {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const lines: string[] = [];
  if (scope.ownData) {
    lines.push(held
      ? `${plural(held.conversations, "conversation", "conversations")}, ${plural(held.memories, "memory", "memories")}, ${plural(held.documents, "document", "documents")}, ${plural(held.todos, "to-do", "to-dos")} and ${plural(held.finishedWork, "finished task", "finished tasks")} kept for you`
      : "the conversations, memories, documents, to-dos and finished tasks kept for you");
  }
  if (scope.wholeCopy) {
    const copy = held?.thisCopy;
    lines.push(copy
      ? `${plural(copy.schedules, "schedule", "schedules")}${copy.automationFlow ? ", the automation flow" : ""}, the preferences${copy.emailAccount ? ", the saved email account and its password" : ""}`
      : "the schedules, the automation flow, the preferences and the saved email account");
  }
  if (scope.license) lines.push("the license key on this PC");
  if (scope.account) lines.push("your account: the email address, name, password, recovery codes and every sign-in");
  return lines;
}
