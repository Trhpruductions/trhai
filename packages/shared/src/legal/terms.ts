import { legalVersions, type LegalFacts } from "../legalFacts.js";
import { fact, type LegalDocument } from "./model.js";

// The Terms of Service.
//
// Written from how TRH AI actually works - a free program on the person's own PC - rather
// than from a template for a website. Where a term is a choice only the owner can make, or
// the kind of wording a lawyer must settle (liability, governing law), it is marked, and
// the facts are the owner's to supply in legalFacts.ts.

export function termsDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  const operator = facts.operatorName;
  return {
    id: "terms",
    title: "Terms of Service",
    summary: `The agreement between you and ${operator} about using ${product}.`,
    version: legalVersions.terms,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "accept",
        heading: "1. Accepting these terms",
        blocks: [
          { kind: "p", text: `By making an account or using ${product}, you agree to these terms. If you do not agree, do not use ${product}.` },
          { kind: "p", text: "How information is handled is described separately in the [Privacy Policy](#legal-privacy). Please read it as well; it is not part of these terms, but it describes what the software does." },
          { kind: "note", tone: "info", text: `${product} runs on your own PC. Most of what these terms cover - your content, your data, how the software behaves - happens there, not on a server of ours.` }
        ]
      },
      {
        id: "what",
        heading: "2. What TRH AI is",
        blocks: [
          { kind: "p", text: `${product} is a program you install on a Windows PC. It starts an AI model on that PC, lets you talk to it, and lets it do things on your behalf when you ask: read and write files in a workspace folder, run programs you have allowed, make documents, set schedules, and so on.` },
          { kind: "p", text: `${operator} makes and operates ${product}. Who that is, and how to reach them, is on the [Business information](#legal-business) page.` }
        ]
      },
      {
        id: "license",
        heading: "3. Your license",
        blocks: [
          { kind: "p", text: `${operator} gives you a personal, non-exclusive, non-transferable license to install and use ${product} on PCs you control.` },
          { kind: "list", items: [
            `**${product} is free.** There is no trial that ends, no license to buy and nothing to pay, and no part of it is locked behind a payment.`,
            "An owner or administrator key, if you were given one, is checked on your PC without the internet. It lets the account with that email look after the other accounts on a copy; nobody needs one to use the software.",
            "You may not sell or sub-license the software."
          ] },
          { kind: "note", tone: "review", text: `Free means free of charge. Whether it may also be used in a business, and whether copies may be passed on to other people, has not been decided: ${operator} must decide, and this section must say. The word "personal" above comes from when licenses were sold, and should be looked at with that.` }
        ]
      },
      {
        id: "accounts",
        heading: "4. Accounts",
        blocks: [
          { kind: "p", text: "Making an account is optional. An account is kept on the PC where you made it, protected by a password only you know. It lets your conversations and memory follow you between browsers on that PC." },
          { kind: "list", items: [
            "Keep your password and your recovery codes safe. There is no server that can reset them: if you lose both, the account cannot be recovered.",
            "You are responsible for what happens under your account on your PC.",
            "Give true information when you make an account, and keep it up to date.",
            "You can delete your account, and the data kept for it, at any time in **Settings, Privacy and consent**."
          ] }
        ]
      },
      {
        id: "age",
        heading: "5. Who may use TRH AI",
        blocks: [
          { kind: "p", text: `You must be at least ${fact(facts.minimumAge, "minimum age")} years old to use ${product} or make an account. ${product} is not made for children and does not knowingly collect information from them; see the [Privacy Policy](#legal-privacy) for what to do if a child's information has been entered.` },
          { kind: "note", tone: "review", text: "The minimum age is a decision for the owner with a lawyer: it depends on the countries where TRH AI is offered (for example, 13 under the US children's privacy law COPPA, and between 13 and 16 under the GDPR, depending on the country). The models TRH AI recommends have had their refusals taken out, which is a reason to choose an older age such as 18. The age box on the sign-up form appears only when a minimum age has been set." }
        ]
      },
      {
        id: "use",
        heading: "6. Using TRH AI properly",
        blocks: [
          { kind: "p", text: "You agree to use TRH AI lawfully and with respect for other people. You must not use it to:" },
          { kind: "list", items: [
            "break the law, or help anyone else to;",
            "make or spread malware, or attack, probe or interfere with systems or accounts you do not own or have no permission to test;",
            "harass, threaten, defraud or deceive anyone, or make sexual content involving children;",
            "infringe other people's copyright, trademarks, privacy or other rights;",
            "get around the limits and safety switches built into the app (such as the machine-access switch);",
            "let other devices or people reach your copy of TRH AI, or the files it can read, in a way that puts other people's data at risk."
          ] },
          { kind: "p", text: `${operator} cannot see what you do with ${product} on your PC, and does not monitor it. You alone are responsible for how you use it and for what you ask it to do.` }
        ]
      },
      {
        id: "ai",
        heading: "7. What the AI makes",
        blocks: [
          { kind: "p", text: "The AI in TRH AI is a language model. It predicts likely words; it does not know whether they are true. Its answers can be wrong, out of date, incomplete or invented, and the same question can get different answers." },
          { kind: "list", items: [
            "Check anything that matters before you rely on it, publish it or act on it.",
            "Answers are **not professional advice**. Do not treat anything it says as medical, legal, financial, tax or safety advice; ask a qualified person.",
            "When the assistant changes files or runs commands for you, those changes are real. Machine access, which lets it work across your whole PC and run commands, is on by default in this version and can be switched off in Tools. Check what it does, and keep copies of anything you cannot afford to lose."
          ] },
          { kind: "p", text: "Read [How TRH AI uses AI](#legal-ai) for more." }
        ]
      },
      {
        id: "content",
        heading: "8. Your content",
        blocks: [
          { kind: "p", text: `What you type, import or make with ${product} is yours, and you are responsible for it - for having the right to use it, and for what you do with what comes back. As far as the law allows, you own the files and text the assistant makes for you.` },
          { kind: "p", text: `${operator} does not receive your content: it stays on your PC. So ${operator} does not ask for any right to use, copy or publish it. The only things that leave your PC are the ones listed in the [Privacy Policy](#legal-privacy) and [Services TRH AI can contact](#legal-services), and only when you do something that needs them.` },
          { kind: "note", tone: "review", text: "Ownership of AI-generated output varies by country and by the licenses of the models used. This section promises only what TRH Development can: it asks for no rights. A lawyer should confirm the wording." }
        ]
      },
      {
        id: "ours",
        heading: "9. What belongs to us, and to others",
        blocks: [
          { kind: "p", text: `${product}, its code, name, logo and look belong to ${operator} or its licensors, and are protected by law. This license does not give you ownership of them.` },
          { kind: "p", text: `${product} uses software and models made by others, each under its own license: the engine that runs the model (llama.cpp), the models themselves, the voices (Piper), speech recognition (whisper.cpp), video tools (ffmpeg) and open-source libraries. They remain the property of their authors. [Services TRH AI can contact](#legal-services) lists them, and **Settings, Engine and models** shows the license of each model and voice. Some are not licensed for commercial use: using them within their licenses is your responsibility.` }
        ]
      },
      {
        id: "services",
        heading: "10. Services we do not control",
        blocks: [
          { kind: "p", text: `${product} can contact other companies' services when you ask it to or install something: GitHub and Hugging Face to download updates, the engine, models and voices; DuckDuckGo for web searches; any website you ask it to read; and your own email provider if you connect an email account. Those services have their own terms and privacy policies, and ${operator} is not responsible for them.` }
        ]
      },
      {
        id: "updates",
        heading: "11. Updates, availability and changes to the software",
        blocks: [
          { kind: "p", text: `${product} works on your PC without our servers, so it does not depend on our service being up. Models and tools you download come from other companies' servers, which may be unavailable.` },
          { kind: "list", items: [
            "The app checks for new versions and offers them. Some updates are marked **required**; those are downloaded and installed automatically, and the app restarts to finish.",
            `${operator} may change, add or remove features. Where a change would remove something you rely on, it will say so in the release notes.`,
            `${product} is early software and some features are still experimental; see [How TRH AI uses AI](#legal-ai).`
          ] }
        ]
      },
      {
        id: "payments",
        heading: "12. Price",
        blocks: [
          { kind: "p", text: `${product} is free. ${operator} charges nothing for it, and it has no payment screen and never asks for card or bank details. The [Refund Policy](#legal-refunds) says what to do if someone charged you for it.` },
          { kind: "p", text: "If that ever changes, it will be a change to these terms, made as section 17 says." }
        ]
      },
      {
        id: "ending",
        heading: "13. Stopping, suspending and ending",
        blocks: [
          { kind: "list", items: [
            "You can stop using TRH AI at any time. Erase your data first if you want it gone (**Settings, Privacy and consent**), then uninstall.",
            `${operator} can end your license if you seriously or repeatedly break these terms. Because ${product} runs on your PC, ${operator} cannot switch it off from outside; ending your license means you agree to stop using the software.`,
            "On a copy of TRH AI that other people sign in to, the person who runs that copy can suspend an account. That is between them and you."
          ] }
        ]
      },
      {
        id: "warranty",
        heading: "14. No warranty",
        blocks: [
          { kind: "p", text: `${product} is provided as it is and as available. As far as the law allows, ${operator} gives no promise that it will be error-free, uninterrupted, accurate or fit for a particular purpose, or that the AI's answers are correct.` },
          { kind: "note", tone: "review", text: "Disclaimers of warranty are limited by consumer law in many countries (for example, statutory guarantees that cannot be excluded). A lawyer must adapt this section for the places where TRH AI is sold." }
        ]
      },
      {
        id: "liability",
        heading: "15. Limits on what we are responsible for",
        blocks: [
          { kind: "p", text: `As far as the law allows, ${operator} is not responsible for indirect or consequential loss, lost profits or lost data, or for harm that comes from relying on what the AI says or from commands you ask it to run. You are responsible for keeping copies of data that matters to you.` },
          { kind: "p", text: "Nothing in these terms limits responsibility that cannot be limited by law, such as for death or personal injury caused by negligence, or for fraud." },
          { kind: "note", tone: "review", text: "This section needs a lawyer. The right limit, and any cap on liability, depends on the law that applies and has not been decided." }
        ]
      },
      {
        id: "law",
        heading: "16. Governing law and disputes",
        blocks: [
          { kind: "p", text: `These terms are governed by ${fact(facts.governingLaw, "the law that governs these terms")}. Disputes are heard in ${fact(facts.disputeVenue, "the courts or arbitration venue for disputes")}. Nothing here takes away rights that the law of the country where you live gives you and that cannot be waived.` },
          { kind: "note", tone: "review", text: "The governing law and the place disputes are heard are for the owner and a lawyer to choose; they are left open on purpose." }
        ]
      },
      {
        id: "changes",
        heading: "17. Changes to these terms",
        blocks: [
          { kind: "p", text: `${operator} may change these terms. Each version has a date (this one is ${legalVersions.terms}). A change that matters is shown in the release notes and, if you have an account, you are asked to read and agree to the new version in **Settings, Privacy and consent**. The version you agreed to, and when, is shown there.` }
        ]
      },
      {
        id: "contact",
        heading: "18. Contact",
        blocks: [
          { kind: "p", text: `Questions about these terms: ${fact(facts.supportEmail, "support email address")}. Who we are: [Business information](#legal-business).` }
        ]
      }
    ]
  };
}
