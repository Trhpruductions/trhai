import { legalVersions, type LegalFacts } from "../legalFacts.js";
import { fact, type LegalDocument } from "./model.js";

// The Privacy Policy.
//
// Every statement about what is stored, what leaves the PC and how long it is kept is
// one the code can be shown to keep (see docs/29-legal-privacy-compliance.md, which
// cites where). It says "encrypted" only where files are encrypted, "local" only where
// work is local, and names each place a request can go. It does not say "private" or
// "secure" without saying against what. What only the owner can supply is left as an
// open item; what the law requires is flagged for a lawyer, not asserted.

export function privacyDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  const operator = facts.operatorName;
  const privacyContact = fact(facts.privacyEmail, "privacy contact email address");
  return {
    id: "privacy",
    title: "Privacy Policy",
    summary: `What ${product} stores, what it sends out, how long it keeps things, and how to see or erase your information.`,
    version: legalVersions.privacy,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "short",
        heading: "1. The short version",
        blocks: [
          { kind: "note", tone: "info", text: `${product} runs on your own PC. The AI that answers you runs there too. What you write, the files it reads and the answers it gives are stored on your PC, encrypted, and are not sent to ${operator} or to any AI company.` },
          { kind: "list", items: [
            `${operator} has no server that your conversations, files or account go to, and no tracking, advertising or analytics in the app.`,
            "A few features contact other companies' services when you use them: a check for new versions, downloads of the engine, models and voices, web searches, web pages you ask it to read, and email you ask it to send. Section 4 lists every one, what it sends and how to stop it.",
            "You can see what is stored (**Settings, Data and privacy**), copy it into a file, and erase it (**Settings, Privacy and consent**).",
            "No system is perfectly secure. Section 8 says what the protection is, and what it is not."
          ] }
        ]
      },
      {
        id: "who",
        heading: "2. Who is responsible",
        blocks: [
          { kind: "p", text: `${operator} makes ${product}; see [Business information](#legal-business) for who that is and how to reach them. For privacy questions and requests: ${privacyContact}.` },
          { kind: "p", text: `Information stored on your PC is in your control. ${operator} does not receive it, so it cannot see it, change it or delete it for you; you do that in the app. The information that ${operator} itself holds is described in section 5.` },
          { kind: "note", tone: "review", text: "Who counts as the data controller for each kind of information (the person using TRH AI for what is on their own PC; TRH Development for its list of issued keys and for support records), and what a business user must do about the people whose information they put into TRH AI, should be confirmed by a lawyer." }
        ]
      },
      {
        id: "kept",
        heading: "3. What is stored on your PC",
        blocks: [
          { kind: "p", text: `All of it is in files on your PC, in ${product}'s data folder. You can see each file, its size and whether it is encrypted under **Settings, Data and privacy**.` },
          {
            kind: "table",
            caption: "What TRH AI keeps on your PC",
            head: ["Kept", "What it holds", "How long"],
            rows: [
              ["Your account", "Email address, display name, the date you made the account and last signed in, a salted hash of your password and hashes of your recovery codes (never the password or codes), hashes of your sign-in sessions, and what you agreed to: which text, which version, when.", "Until you erase the account. A sign-in session lasts up to 30 days or until you sign out."],
              ["Conversations", "Every message you send and every answer, with the conversation's title, whether it is pinned or archived, and the model used.", "Until you delete them or erase your data. Each conversation keeps its latest 200 messages."],
              ["Memory", "Facts you ask TRH AI to remember, with a short note of anything you asked it to forget (so it does not bring it back up from the conversation), and a record of changes to your memory.", "Until you delete them or erase your data."],
              ["Documents, to-dos, calendar, finished work", "Documents you give it to read, your to-do list, your calendar, the job it is working on or last worked on (your request and its result), and the work it has finished, with the steps it took and the commands it ran.", "Until you delete them or erase your data."],
              ["Schedules and the automation flow", "What you have set to run on a timer and the result of each run; the automation flow you saved.", "Until you delete them or erase your data."],
              ["Preferences", "The assistant's personality you chose, and the kind of phone you linked in Phone Link.", "Until you change or erase them."],
              ["An email account, if you connect one", "The address, the mail server, the port and the app password you gave, so the assistant can send email on your behalf when you ask.", "Until you remove it or erase your data."],
              ["A key, if you entered one", "An owner or administrator key, or a license key from before TRH AI became free, which contains the email address it was issued for. A PC that ran an earlier version may also hold the date its free trial began, in the license file and a small marker file; nothing uses it now.", "The key until you remove it. The old trial date stays: it holds no personal information."],
              ["Settings that protect the PC", "Whether machine access is on, and the access key other devices need if you let them in.", "Until you change them."],
              ["Record of changes to accounts", "Only on a copy of TRH AI that other people sign in to: who suspended, reactivated or gave a role to whom, and when.", "Kept in order; up to 10,000 entries. When an account is erased its email address is taken out."],
              ["Record of erasures", "That an erasure was asked for and carried out: its date, what it covered and a random number. No name and no email.", "24 months."],
              ["Log files", "The service logs what it did: which routes were asked for and how they answered (never the part of an address that carries a search, a file name or a session id), the program and length of each command it ran (never the command), and errors.", "Up to 30 days; a log over 2 MB is moved aside and one earlier copy is kept."],
              ["Files TRH AI makes", "Documents, apps, videos and other files it makes for you, in the workspace folder you can open.", "They are your files: TRH AI does not delete them."]
            ]
          },
          { kind: "p", text: "Everything the app owns is written encrypted (AES-256-GCM) with a key that is kept on the same PC. That protects a copied or backed-up folder. It does not protect against someone who can sign in to your Windows account, because they can read the key too: the **Data and privacy** screen says so as well." },
          { kind: "p", text: "In your browser or the app's window, a few small settings are kept too - which conversation is open, your accent colour and so on. [Cookies and browser storage](#legal-storage) lists every one. TRH AI sets no cookies." }
        ]
      },
      {
        id: "leaves",
        heading: "4. What leaves your PC",
        blocks: [
          { kind: "p", text: `${product} sends nothing about you to ${operator}. These are the only requests it makes to anything outside your PC. [Services TRH AI can contact](#legal-services) gives the details and the other companies' own privacy policies.` },
          {
            kind: "table",
            caption: "Everything TRH AI can send outside your PC",
            head: ["What", "When", "What the other side gets", "How to stop it"],
            rows: [
              ["A check for a newer version (GitHub)", "When TRH AI is open: at most once every 6 hours, and when you press Check now.", "Your internet address, and `TRH-AI/` with the version you run. Nothing about you or your data.", "Set the environment variable `TRHAI_UPDATE_CHECK` to `off`."],
              ["Downloading an update (GitHub)", "When you choose to install an update; or, for an update marked required, automatically.", "Your internet address and the file asked for.", "Do not choose to update. A required update installs by itself."],
              ["Downloading the engine, models, voices and tools (GitHub, Hugging Face and similar sites)", "When you install them in **Settings, Engine and models**, and for the parts TRH AI needs to start working.", "Your internet address and the file asked for. No conversation is sent.", "Do not install them; remove them there."],
              ["A web search (DuckDuckGo)", "When you ask TRH AI to search the web.", "The words searched, your internet address and a browser-like identifier.", "Do not ask it to search the web."],
              ["Reading a web page", "When you ask TRH AI to read a page, or use the Browser screen.", "The address you asked for is requested from that site, which sees your internet address.", "Do not ask it to."],
              ["Checking the internet connection (DuckDuckGo)", "Only when you press Check now on the Network screen.", "Your internet address.", "Do not press it."],
              ["Email", "When you ask it to send one, if you connected an email account.", "The message goes through your mail provider's server, with the account details you gave it.", "Do not connect an email account, or remove it."]
            ]
          },
          { kind: "p", text: `${product} does not use advertising, analytics, crash reporting or tracking services, and does not load fonts, scripts or images from other companies.` }
        ]
      },
      {
        id: "holds",
        heading: `5. What ${operator} holds`,
        blocks: [
          { kind: "p", text: `The app tells ${operator} nothing. ${operator} holds only what a person gives it in order to get a key, or to ask for help:` },
          { kind: "list", items: [
            "**When a key is issued:** the email address it is for, the date and a key number, written to a list kept on the owner's own PC. TRH AI is free, so nobody is asked to pay and no card or bank details are involved.",
            "**When you write for help or about privacy:** your message and your email address.",
            `**Kept for:** the list of issued keys for ${fact(facts.keyRecordRetentionYears, "how many years the business keeps its list of the keys it issued")} years; messages for as long as it takes to deal with them.`
          ] },
          { kind: "note", tone: "review", text: "How long these records should be kept, and the legal basis for holding each of them, depend on the country the business is established in and must be settled with a lawyer. If any license was sold before TRH AI became free, records of those sales may have to be kept for tax and accounts." }
        ]
      },
      {
        id: "why",
        heading: "6. Why information is used",
        blocks: [
          { kind: "list", items: [
            "To do what you ask: answering, remembering, reading your files and making things for you.",
            "To keep you signed in, and to keep one person's conversations apart from another's on the same PC.",
            "To check an owner or administrator key, if you entered one, on your PC, without the internet.",
            "To tell you about new versions, and to download what you choose to install.",
            "To look after the software: the logs help find why something failed.",
            "To keep records the law may require, and to answer your requests."
          ] },
          { kind: "p", text: "Information is never used to train or improve any AI model: it does not leave your PC to do so, and the model running on your PC does not learn from it." }
        ]
      },
      {
        id: "ai",
        heading: "7. How the AI uses your information",
        blocks: [
          { kind: "p", text: `The model reads what it needs to answer you - your message, earlier parts of the conversation, the memories and documents that match what you asked, and files you point it to - and writes an answer. That all happens on your PC. See [How TRH AI uses AI](#legal-ai).` },
          { kind: "p", text: "A model is a fixed file: it does not remember you between questions. What looks like memory is the conversation and memory kept on your PC, which are given to the model again each time." }
        ]
      },
      {
        id: "protect",
        heading: "8. How information is protected",
        blocks: [
          { kind: "list", items: [
            "**Encrypted storage.** The files TRH AI owns are encrypted (AES-256-GCM) with a key on your PC. See section 3 for what that does and does not protect against.",
            "**Passwords.** Only a salted scrypt hash of your password is kept, and hashes of recovery codes and sign-in sessions. They cannot be turned back into the originals.",
            "**Only your PC can reach it.** The service and the app listen on your PC's own address. Other devices cannot connect unless you turn on network access, and then each needs a key.",
            "**Limits on guessing.** Signing in, recovering an account and changing a password are rate-limited.",
            "**Safety switches.** Machine access and network access are switches you control. Machine access is on by default in this version; see [How TRH AI uses AI](#legal-ai).",
            "**The window.** The app's window is sandboxed: a web page shown in it cannot run programs on your PC, and only the app's own pages may use the microphone."
          ] },
          { kind: "p", text: "None of this makes any system perfectly secure. Anyone who can sign in to your Windows account, or who can run programs as you, can read what TRH AI can read. Use a Windows password, and lock your PC." }
        ]
      },
      {
        id: "retention",
        heading: "9. How long information is kept",
        blocks: [
          { kind: "p", text: "The table in section 3 gives each period. In short: your information stays on your PC until you remove it. When you erase it, it is deleted from the files and from the one copy of the accounts file that TRH AI makes when it upgrades that file; it is not hidden or marked. Backups you made yourself, such as a copy of the folder, are yours to delete." },
          { kind: "note", tone: "review", text: "The retention periods above (30 days for logs, 24 months for records of erasure) are working values chosen by the developer, not decided by the business with a lawyer. Confirm or change them." }
        ]
      },
      {
        id: "rights",
        heading: "10. Your choices and rights",
        blocks: [
          { kind: "list", items: [
            "**See what is stored:** Settings, Data and privacy.",
            "**Get a copy:** Settings, Privacy and consent, Copy my data. It is one file you can open, in plain words.",
            "**Erase it:** Settings, Privacy and consent, Erase. You choose what to erase and type a word to confirm; with an account, you also enter your password. A short note says what was and was not removed.",
            "**Correct it:** edit conversations, memories, documents, to-dos and calendar events in the app. To change an account's name or email, erase the account and make a new one.",
            "**Say no to optional storage:** the choices in **Settings, Privacy and consent** control the optional settings kept in your browser.",
            "**Ask us:** about information held by TRH Development, write to the privacy address in section 2."
          ] },
          { kind: "p", text: "Where the law gives you more - for example to object to processing, to ask for your information to be restricted, or to complain to a data protection authority - those rights are yours too." },
          { kind: "note", tone: "review", text: "The specific rights, response deadlines (for example one month under the GDPR, 45 days in some US states) and the authority to complain to depend on where people using TRH AI live. A lawyer must list them." }
        ]
      },
      {
        id: "children",
        heading: "11. Children",
        blocks: [
          { kind: "p", text: `${product} is not made for children, and you must be at least ${fact(facts.minimumAge, "minimum age")} to use it or make an account. ${operator} does not receive information from the app, so it does not knowingly collect children's information. If a child's information has been put into a copy of TRH AI, a parent or guardian can erase it under **Settings, Privacy and consent**; to ask ${operator} to delete a child's information it holds, write to ${privacyContact}.` },
          { kind: "note", tone: "review", text: "Asking people to confirm their age is not, by itself, compliance with children's privacy laws such as COPPA. The age limit, and what to do if a child's information is held, must be settled with a lawyer. Nothing here claims compliance." }
        ]
      },
      {
        id: "places",
        heading: "12. Where information goes",
        blocks: [
          { kind: "p", text: `Information on your PC stays in the country the PC is in. The services in section 4 are run by companies in other countries (mostly the United States), and the request goes there when you use them. Where ${operator} holds its list of issued keys, it is kept in ${fact(facts.jurisdiction, "country where the business keeps its records")}.` },
          { kind: "note", tone: "review", text: "Whether transfers to those services need safeguards (for example standard contractual clauses) depends on where people using TRH AI live." }
        ]
      },
      {
        id: "changes",
        heading: "13. Changes to this policy",
        blocks: [
          { kind: "p", text: `This policy has a date (this version is ${legalVersions.privacy}). When it changes in a way that matters, the release notes say so and, if you have an account, you are asked to read it again in **Settings, Privacy and consent**. Earlier versions are kept in the project's history.` }
        ]
      },
      {
        id: "contact",
        heading: "14. Contact",
        blocks: [
          { kind: "p", text: `Privacy questions and requests: ${privacyContact}. Postal address and other details: [Business information](#legal-business).` }
        ]
      }
    ]
  };
}
