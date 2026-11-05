// What the legal texts depend on: the version of each text, and the facts about
// the business that only its owner can supply.
//
// One place on purpose. The pages (privacy, terms, refunds, storage, business
// information), the registration form, the consent records the service keeps and
// the exported copies for a website all read from here, so correcting a fact or
// bumping a version cannot leave one of them saying something else.
//
// A fact the owner has not supplied is `null`, never a guess. The pages show such
// a fact as an open item (see legalDocuments.ts), so nothing invented can reach
// a reader, and a test refuses to call the texts "reviewed" while any is open.

/** A fact only the owner can supply. null means not supplied yet. */
export type Fact<T> = T | null;

/**
 * The version of each text a person can agree to, as the date it took effect.
 *
 * A consent record names the version that was shown, so the words a person
 * agreed to can always be found again. Change the words, change the version:
 * legal-versions.test.ts keeps a fingerprint of each text and fails when the
 * words moved and the version did not.
 */
export const legalVersions = {
  terms: "2026-11-01",
  privacy: "2026-11-01",
  refunds: "2026-11-01",
  storage: "2026-11-02",
  ai: "2026-11-01"
} as const;

export type LegalVersionKey = keyof typeof legalVersions;

/** The texts a person is asked to agree to or acknowledge when making an account. */
export const consentDocuments = ["terms", "privacy"] as const satisfies readonly LegalVersionKey[];

export type LegalStatus =
  /** Written from what the app does; not yet read by a lawyer. The pages say so. */
  | "draft"
  /** A lawyer has read it and the owner has supplied every fact. */
  | "reviewed";

export type LegalFacts = {
  productName: string;
  /** The name the owner gave for the business that makes and operates TRH AI. */
  operatorName: string;
  status: LegalStatus;
  /** When the current texts took effect (YYYY-MM-DD). */
  effectiveDate: string;

  /** Who the business is in law. */
  legalEntityName: Fact<string>;
  registrationNumber: Fact<string>;
  postalAddress: Fact<string>;
  /** Country and, where it matters, state or province, of the business. */
  jurisdiction: Fact<string>;

  /** Where a person writes to. */
  website: Fact<string>;
  supportEmail: Fact<string>;
  privacyEmail: Fact<string>;
  businessEmail: Fact<string>;

  /** The law that governs the Terms, and where disputes are heard. For a lawyer to settle. */
  governingLaw: Fact<string>;
  disputeVenue: Fact<string>;

  /** The youngest a person may be to make an account or buy a license. A decision for the owner and a lawyer. */
  minimumAge: Fact<number>;

  /** The company that takes a payment on the checkout page, if there is one. TRH AI itself never sees a card. */
  paymentProvider: Fact<string>;
  /** How many days after buying a person may ask for their money back, if the owner offers one. */
  refundWindowDays: Fact<number>;
  /** How long the business keeps the record of a sale (the buyer's email, plan, date), for tax and accounts. */
  salesRecordRetentionYears: Fact<number>;
};

/**
 * The facts as they stand. Everything the owner has not yet supplied is null and
 * shows up on the pages as an open item.
 */
export const legalFacts: LegalFacts = {
  productName: "TRH AI",
  operatorName: "TRH Development",
  status: "draft",
  effectiveDate: "2026-11-01",

  legalEntityName: null,
  registrationNumber: null,
  postalAddress: null,
  jurisdiction: null,

  website: null,
  supportEmail: null,
  privacyEmail: null,
  businessEmail: null,

  governingLaw: null,
  disputeVenue: null,

  minimumAge: null,

  paymentProvider: null,
  refundWindowDays: null,
  salesRecordRetentionYears: null
};
