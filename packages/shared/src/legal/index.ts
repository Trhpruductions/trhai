import { legalFacts, legalVersions, type LegalFacts } from "../legalFacts.js";
import { aiDocument } from "./ai.js";
import { businessDocument } from "./business.js";
import { legalDocIds, openItemsIn, type LegalDocId, type LegalDocument } from "./model.js";
import { privacyDocument } from "./privacy.js";
import { refundsDocument } from "./refunds.js";
import { servicesDocument } from "./services.js";
import { storageDocument } from "./storage.js";
import { termsDocument } from "./terms.js";

// The one list of TRH AI's legal texts. Everything that shows, exports or agrees to a
// text goes through here, so there is one Privacy Policy, not a screen's version and a
// website's version.

const makers: Record<LegalDocId, (facts: LegalFacts) => LegalDocument> = {
  privacy: privacyDocument,
  terms: termsDocument,
  refunds: refundsDocument,
  storage: storageDocument,
  ai: aiDocument,
  business: businessDocument,
  services: servicesDocument
};

/** One text, written from the facts as they stand. */
export function legalDocument(id: LegalDocId, facts: LegalFacts = legalFacts): LegalDocument {
  return makers[id](facts);
}

/** Every text, in the order the screens list them. */
export function legalDocuments(facts: LegalFacts = legalFacts): LegalDocument[] {
  return legalDocIds.map((id) => makers[id](facts));
}

/** Everything the owner has still to supply, across every text, each item once. */
export function openLegalItems(facts: LegalFacts = legalFacts): string[] {
  const found: string[] = [];
  for (const doc of legalDocuments(facts)) {
    for (const label of openItemsIn(doc)) if (!found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * Whether the texts may be shown without the draft notice: a lawyer has read them and no
 * fact is still open. The notice shows whenever this is false, so a reader always knows.
 */
export function legalTextsReady(facts: LegalFacts = legalFacts): boolean {
  return facts.status === "reviewed" && openLegalItems(facts).length === 0;
}

/** The sentence shown above a text while it is a draft. */
export const draftNotice = "This text was written from what TRH AI does and has not yet been reviewed by a lawyer. Items marked to be supplied are facts the business has still to fill in. Nothing here is made up to fill a gap.";

export { legalVersions };

const shortTitles: Record<LegalDocId, string> = {
  privacy: "Privacy Policy",
  terms: "Terms of Service",
  refunds: "Refund Policy",
  storage: "Cookies and storage",
  ai: "How it uses AI",
  business: "Business information",
  services: "Services and licences"
};

/** A text's name where there is room for two or three words: a tab, a link, a menu. */
export function legalShortTitle(id: LegalDocId): string {
  return shortTitles[id];
}
