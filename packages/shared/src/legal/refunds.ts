import { legalVersions, type LegalFacts } from "../legalFacts.js";
import { fact, type LegalDocument } from "./model.js";

// The Refund Policy.
//
// It states how TRH AI is actually paid for - a free 14-day trial, then a license key
// that TRH Development issues, with payment taken on a checkout page by a provider and
// never inside the app - and nothing more. The refund window itself is the owner's
// decision: it is left open until the owner sets refundWindowDays, and is never filled
// in here with a promise nobody made. What the law may require is described as that,
// and flagged for a lawyer.

export function refundsDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  const operator = facts.operatorName;
  const days = facts.refundWindowDays;
  return {
    id: "refunds",
    title: "Refund Policy",
    summary: `How refunds work for ${product}: what you can ask for, how to ask, and what happens next.`,
    version: legalVersions.refunds,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "how-paid",
        heading: "How TRH AI is paid for",
        blocks: [
          {
            kind: "list",
            items: [
              "**The trial is free.** A new installation can be used for 14 days with nothing to pay, and no payment details are asked for. There is nothing to refund.",
              `**A license key** unlocks ${product} after the trial. ${operator} issues keys.`,
              `**Payment** for a license, where there is a charge, is taken on a checkout page in your browser, run by ${fact(facts.paymentProvider, "payment provider that takes payment on the checkout page, if there is one")}. ${product} has no payment screen and never sees your card or bank details. Any subscription or repeating charge is shown on the checkout page before you pay.`
            ]
          },
          { kind: "note", tone: "info", text: `Refunds are paid back by the company that took the payment, to the way you paid. ${operator} asks that company to make the refund; ${product} cannot move money.` }
        ]
      },
      {
        id: "window",
        heading: "Asking for a refund",
        blocks: [
          {
            kind: "p",
            text: days === null
              ? `You can ask ${operator} for a refund of a license you bought. ${operator}'s refund window - how long after buying you may ask, and in what circumstances a refund is made - is ${fact(days, "the number of days after buying in which TRH Development refunds a license, and the conditions, or a statement that it offers no discretionary refund")}.`
              : `You can ask ${operator} for a refund of a license within ${days} day${days === 1 ? "" : "s"} of buying it. After that, a refund is considered only in the cases listed below, or where the law requires one.`
          },
          { kind: "note", tone: "review", text: "The length of the refund window, and whether any is offered beyond what the law requires, is a business decision that has not been made. It is left open on purpose: no refund promise has been invented here." }
        ]
      },
      {
        id: "always",
        heading: "Cases that are put right whatever the window",
        blocks: [
          {
            kind: "list",
            items: [
              "**A duplicate payment.** If you were charged twice for one license, the extra charge is refunded.",
              "**A failed purchase.** If you were charged and no license key reached you, you will be sent the key or refunded.",
              "**A billing error.** If the amount charged was not the amount shown on the checkout page, the difference is refunded.",
              "**An unauthorized transaction.** If a charge was made that you did not make, contact your bank or card company straight away and tell us too, so the license it bought can be withdrawn and the payment provider can help."
            ]
          }
        ]
      },
      {
        id: "law",
        heading: "Your rights under the law",
        blocks: [
          {
            kind: "p",
            text: "Nothing in this policy takes away a right the law gives you as a consumer. In some countries a buyer has a right to cancel a purchase of digital content within a set time - 14 days in the European Union and the United Kingdom, for example - and in some cases that right ends once you ask for the content to be delivered at once. Other places give rights in other ways, or none for a digital purchase."
          },
          { kind: "note", tone: "review", text: "Which consumer-protection rules apply, and how a license key delivered immediately interacts with them (including any waiver of a cancellation right and how consent to it is obtained), depends on where TRH AI is sold and must be settled with a lawyer." }
        ]
      },
      {
        id: "how",
        heading: "How to ask",
        blocks: [
          {
            kind: "list",
            ordered: true,
            items: [
              `Write to ${fact(facts.supportEmail, "support email address")} from the address you used to buy.`,
              "Say what you bought, when you bought it and why you are asking. Include the receipt or order number from the checkout page if you have it.",
              "We will reply to say whether the refund is being made and, if it is not, why not."
            ]
          },
          {
            kind: "p",
            text: `Once a refund is made, the company that took the payment sends it back the way you paid. When it appears depends on your bank or card company, which ${operator} does not control. If it has not arrived after the time they tell you to expect, ask them first, then write to us with the date of the refund.`
          }
        ]
      },
      {
        id: "after",
        heading: "After a refund",
        blocks: [
          {
            kind: "p",
            text: `${product} checks a license key on your own PC, without the internet, so a key cannot be switched off from outside. When a license is refunded, you agree to stop using it and to remove the key (**Settings, Plan and billing**). Everything you made with ${product} stays on your PC and stays yours.`
          },
          { kind: "note", tone: "review", text: "A refunded key keeps working until it is removed, because the app has no server to revoke it. A lawyer should confirm that a promise to stop using a refunded license is the right way to handle that." }
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
