import { legalVersions, type LegalFacts } from "../legalFacts.js";
import { fact, type LegalDocument } from "./model.js";

// The Refund Policy.
//
// TRH AI is free (the owner's decision of 2026-11-05), so this says that and what follows
// from it, and no more. The page stays because the links to it stay, and because someone
// may have paid for a key before: no promise is made about those here, only where to write.

export function refundsDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  const operator = facts.operatorName;
  return {
    id: "refunds",
    title: "Refund Policy",
    summary: `${product} is free, so there is nothing to refund. What to do if you paid someone for it.`,
    version: legalVersions.refunds,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "free",
        heading: `${product} is free`,
        blocks: [
          { kind: "p", text: `${product} costs nothing to use. There is no trial that ends, no license to buy and no subscription. It has no payment screen and never asks for card or bank details, so there is nothing to refund.` }
        ]
      },
      {
        id: "paid",
        heading: "If you paid for it",
        blocks: [
          { kind: "list", items: [
            `**If you paid for a license before ${product} became free,** write to ${fact(facts.supportEmail, "support email address")} and say what you bought and when.`,
            `**If someone charged you for a copy of ${product},** ${operator} does not sell it, so that was someone else. Official installers are free, at the address on the [Business information](#legal-business) page. Ask whoever charged you, or your bank or card company, about getting your money back.`
          ] },
          { kind: "note", tone: "review", text: "Whether anything is owed to someone who paid for a license before TRH AI became free has not been decided, and no promise is made here. TRH Development should settle that, with a lawyer if any license was sold." }
        ]
      },
      {
        id: "law",
        heading: "Your rights under the law",
        blocks: [
          { kind: "p", text: "Nothing in this policy takes away a right the law gives you as a consumer." }
        ]
      },
      {
        id: "contact",
        heading: "Contact",
        blocks: [
          { kind: "p", text: `Questions about this policy: ${fact(facts.supportEmail, "support email address")}. Who we are: [Business information](#legal-business).` }
        ]
      }
    ]
  };
}
