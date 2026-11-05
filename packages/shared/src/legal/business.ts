import type { LegalFacts } from "../legalFacts.js";
import { fact, type LegalDocument } from "./model.js";

// Business information: who makes TRH AI and how to reach them.
//
// Nothing here is written from memory or guessed. Each detail is a fact the owner
// supplies in legalFacts.ts; until they do, the page says what is missing instead.

export function businessDocument(facts: LegalFacts): LegalDocument {
  return {
    id: "business",
    title: "Business information",
    summary: `Who makes and operates ${facts.productName}, how to reach them, and where the software comes from.`,
    version: null,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "who",
        heading: "Who makes and operates TRH AI",
        blocks: [
          { kind: "p", text: `${facts.productName} is made and operated by **${facts.operatorName}**.` },
          {
            kind: "table",
            caption: "Business details",
            head: ["Detail", "Value"],
            rows: [
              ["Name it trades under", facts.operatorName],
              ["Legal entity", fact(facts.legalEntityName, "legal entity name")],
              ["Registration number", fact(facts.registrationNumber, "company registration number, or a statement that there is none")],
              ["Postal address", fact(facts.postalAddress, "business postal address")],
              ["Country or state where the business is established", fact(facts.jurisdiction, "country or state where the business is established")]
            ]
          },
          {
            kind: "note",
            tone: "review",
            text: "Every detail above must be filled in by the business with information it can prove (a registration certificate, a lease or a registered agent's address) before this page is published. None of it is guessed here."
          }
        ]
      },
      {
        id: "contact",
        heading: "How to reach us",
        blocks: [
          {
            kind: "table",
            caption: "Where to write",
            head: ["For", "Contact"],
            rows: [
              ["The official website", fact(facts.website, "official website address")],
              ["Help using TRH AI", fact(facts.supportEmail, "support email address")],
              ["Privacy questions and requests", fact(facts.privacyEmail, "privacy contact email address")],
              ["Business enquiries", fact(facts.businessEmail, "business contact email address")]
            ]
          },
          {
            kind: "p",
            text: "Information that TRH AI keeps on your own PC needs no one's help to see or remove: **Settings, Privacy and consent** copies it into a file and erases it. Write to the privacy address above about information that TRH Development itself holds, such as the record of a key it issued to you."
          }
        ]
      },
      {
        id: "software",
        heading: "Where the software and its updates come from",
        blocks: [
          {
            kind: "p",
            text: `Official installers of ${facts.productName} are published as releases at **https://github.com/Trhpruductions/trhai/releases**, together with a list of their SHA-256 checksums (\`SHA256SUMS.txt\`). The app looks for newer versions at that address and nowhere else. Treat an installer from any other place as unofficial.`
          },
          {
            kind: "p",
            text: "The installer is not yet signed with a code-signing certificate, so Windows SmartScreen may warn the first time you run it. Compare the checksum of what you downloaded with the published list if you want to be sure it is the file that was released."
          }
        ]
      },
      {
        id: "payments",
        heading: "Price and keys",
        blocks: [
          {
            kind: "p",
            text: `${facts.productName} is free: ${facts.operatorName} charges nothing for it, and it has no payment screen and never sees a card or bank number. Owner and administrator keys, which let an account look after the other accounts on a copy, are issued by ${facts.operatorName}; nobody needs one to use the software. See the [Terms of Service](#legal-terms) for what you may do with it, and the [Refund Policy](#legal-refunds) if someone charged you for it.`
          }
        ]
      }
    ]
  };
}
