import type { Express, Request, Response } from "express";
import { legalFacts, legalVersions } from "@ascend/shared";
import { authorityMode, resolvePrincipal, type Principal } from "./services/access.js";
import { passwordMatches } from "./services/accounts.js";
import {
  acceptCurrentTexts, buildExport, consentStatus, eraseSubject, heldBy, mayHandleWholeCopy, requestRecordMonths,
  type EraseScope, type Subject
} from "./services/privacy.js";
import { checkRateLimit, clearRateLimit, passwordChangeRule, recordFailure } from "./services/rateLimit.js";
import { normalizeSessionId, resolveMemoryKey } from "./services/sessionKey.js";

// The routes that let a person see what they agreed to, take a copy of what TRH AI
// holds for them, and have it erased.
//
// None of them sits behind the paywall or an entitlement: the right to your own
// data does not lapse with a trial. What decides what a request may do is who it
// is - the account behind its token, or the anonymous session id of a person who
// never made one - and, for the parts of a copy of TRH AI that are not kept under
// anyone's key, whether that copy is the person's own PC or one other people share.

const traceId = "trace-local";

/** The word a person types to confirm an erasure. */
export const eraseConfirmation = "ERASE";

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message, traceId });
}

/** Whose data a request is about, or null when it names neither an account nor a session. */
function subjectOf(req: Request, sessionId: unknown, principal: Principal): Subject | null {
  const key = resolveMemoryKey(req, normalizeSessionId(sessionId));
  return key ? { key, account: principal.account } : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

export function registerPrivacyRoutes(app: Express): void {
  // What the privacy screen needs: the texts and their versions, where this person stands
  // on each, what may be erased by them, and how much of each kind is held.
  app.get("/v1/privacy/summary", (req, res) => {
    const principal = resolvePrincipal(req);
    const subject = subjectOf(req, req.query.sessionId, principal);
    const wholeCopyAllowed = mayHandleWholeCopy(principal.role);
    res.json({
      data: {
        texts: { status: legalFacts.status, effectiveDate: legalFacts.effectiveDate, versions: legalVersions },
        minimumAge: legalFacts.minimumAge,
        signedIn: principal.signedIn,
        sharedCopy: authorityMode(),
        consents: principal.account ? consentStatus(principal.account.id) : [],
        wholeCopyAllowed,
        held: subject ? heldBy(subject, { wholeCopy: wholeCopyAllowed }) : null,
        requestRecordMonths
      },
      traceId
    });
  });

  // Agreeing to the texts as they stand now - after one changed, or for an account made
  // before agreements were kept.
  app.post("/v1/privacy/consents", (req, res) => {
    const principal = resolvePrincipal(req);
    if (!principal.account) {
      refuse(res, 401, "UNAUTHORIZED", "Sign in to record what you agree to.");
      return;
    }
    const result = acceptCurrentTexts(principal.account.id, req.body?.consents, "settings");
    if (!result.ok) {
      refuse(res, result.status, result.code, result.message);
      return;
    }
    res.json({ data: { consents: result.lines }, traceId });
  });

  // A copy of everything held for the person, as one file.
  app.get("/v1/privacy/export", (req, res) => {
    const principal = resolvePrincipal(req);
    const subject = subjectOf(req, req.query.sessionId, principal);
    if (!subject) {
      refuse(res, 400, "INVALID_REQUEST", "Sign in, or say which session to copy.");
      return;
    }
    const copy = buildExport(subject, { wholeCopy: mayHandleWholeCopy(principal.role) });
    const stamp = copy.exportedAt.slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="trh-ai-my-data-${stamp}.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(JSON.stringify(copy, null, 2));
  });

  // Erasure. Signed in, it asks for the person's own password as well as the typed word:
  // a session left open on a shared screen is not enough to end an account.
  app.post("/v1/privacy/erase", (req, res) => {
    const principal = resolvePrincipal(req);
    const subject = subjectOf(req, req.body?.sessionId, principal);
    if (!subject) {
      refuse(res, 400, "INVALID_REQUEST", "Sign in, or say which session to erase.");
      return;
    }
    if (typeof req.body?.confirm !== "string" || req.body.confirm.trim() !== eraseConfirmation) {
      refuse(res, 400, "CONFIRMATION_REQUIRED", `Type ${eraseConfirmation} to confirm. Nothing was erased.`);
      return;
    }

    const asked = (req.body?.scope && typeof req.body.scope === "object" ? req.body.scope : {}) as Record<string, unknown>;
    const scope: EraseScope = {
      ownData: asBoolean(asked.ownData),
      wholeCopy: asBoolean(asked.wholeCopy),
      license: asBoolean(asked.license),
      account: asBoolean(asked.account)
    };
    if (!scope.ownData && !scope.wholeCopy && !scope.license && !scope.account) {
      refuse(res, 400, "INVALID_REQUEST", "Choose what to erase. Nothing was erased.");
      return;
    }
    if (scope.account && !principal.account) {
      refuse(res, 400, "INVALID_REQUEST", "There is no account to erase: you are not signed in. Nothing was erased.");
      return;
    }
    if ((scope.wholeCopy || scope.license) && !mayHandleWholeCopy(principal.role)) {
      refuse(res, 403, "FORBIDDEN", "Only the owner of this copy of TRH AI can erase what is shared by everyone who uses it. Nothing was erased.");
      return;
    }
    if (scope.account && authorityMode() && principal.role === "owner") {
      refuse(res, 409, "OWNER_ACCOUNT", "This is the owner account. Hand ownership to someone else before erasing it. Nothing was erased.");
      return;
    }

    if (principal.account) {
      const limitKey = `erase-password:${principal.account.id}`;
      const check = checkRateLimit(limitKey, passwordChangeRule);
      if (!check.allowed) {
        res.setHeader("Retry-After", String(check.retryAfterSeconds));
        res.status(429).json({ code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait and try again.", retryAfterSeconds: check.retryAfterSeconds, traceId });
        return;
      }
      if (!passwordMatches(principal.account.id, req.body?.password)) {
        recordFailure(limitKey, passwordChangeRule);
        refuse(res, 403, "PASSWORD_REQUIRED", "That password is not right. Nothing was erased.");
        return;
      }
      clearRateLimit(limitKey);
    }

    const report = eraseSubject(subject, scope);
    // Always 200 once the request was understood and carried out as far as it could be: the body says
    // what was done and what was not, and a failure status would hide that from the screen.
    res.json({
      data: { ...report, signedOut: scope.account && report.removed.account === 1 },
      traceId
    });
  });
}
