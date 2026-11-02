import { legalVersions, type LegalFacts } from "../legalFacts.js";
import type { LegalDocument } from "./model.js";

// "Cookies and browser storage": the cookie policy.
//
// TRH AI sets no cookies at all (nothing in the service, the interface or the desktop shell
// sets or reads one), so a cookie policy that listed some would be inventing them. What it
// does keep in the window's storage is a short list of named items, and every one is here,
// split into those the app cannot work or behave without and those that only remember a
// choice - the second kind is what the question at the bottom of the app controls
// (apps/trhai-web/src/lib/storageConsent.ts holds the same list as code and a test keeps the
// two from drifting apart).

export function storageDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  return {
    id: "storage",
    title: "Cookies and browser storage",
    summary: `${product} sets no cookies. This lists the small settings it keeps in its window, why, and how to change them.`,
    version: legalVersions.storage,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "short",
        heading: "1. The short version",
        blocks: [
          { kind: "note", tone: "info", text: `${product} sets **no cookies**, and has no advertising, analytics or tracking technology of any kind, from itself or anyone else. It does keep a short list of small named settings in the storage that belongs to its window on your PC. Nothing in that storage is sent anywhere.` },
          { kind: "p", text: "Some of those settings the app cannot work or behave without. The rest only remember a choice you made, such as an accent colour; they are stored only if you allow it, and you can change your mind at any time in **Settings, Privacy and consent**." }
        ]
      },
      {
        id: "what",
        heading: "2. What this means",
        blocks: [
          { kind: "p", text: "A cookie is a small piece of information that a website asks your browser to keep and send back with later requests. Browsers have a similar place, called local storage and session storage, that a page can use without sending anything back. TRH AI's window is a browser window, so it has that place; it uses it, and not cookies." },
          { kind: "p", text: "Local storage stays until it is cleared. Session storage goes when the window closes." }
        ]
      },
      {
        id: "needed",
        heading: "3. Settings the app needs",
        blocks: [
          { kind: "p", text: "These are always kept, because the app would not work, or would not behave, without them: it would not know you were signed in, could not find your conversations again, or would show you a notice you had already put away. They need no consent and cannot be switched off." },
          {
            kind: "table",
            caption: "Settings the app needs",
            head: ["Name", "What it holds", "Kept in", "Until"],
            rows: [
              ["`trhai.auth.v1`", "Your sign-in: the session token and a summary of your account (its id, email, name and the date it was made).", "Local storage if you chose Keep me signed in, otherwise session storage.", "You sign out, the session ends (up to 30 days), or the window closes (session storage)."],
              ["`trhai.guest.v1`", "That you chose to continue without an account.", "Session storage.", "The window closes."],
              ["`trhai.session.v1`", "A random number that stands for this browser when you are not signed in, so that your conversations and memory are found again.", "Local storage.", "You erase your data or clear the app's storage."],
              ["`trhai.update.install-tried.v1`", "The version for which an automatic restart was already tried, so a failed install cannot make the app restart again and again.", "Local storage.", "The install finishes."],
              ["`trhai.whatsnew.seen.v1`, `trhai.update.dismissed.v1`, `trhai.setup.dismissed.v1`, `trhai.setup.tools-offered.v1`, `trhai.rendering.dismissed.v1`", "Notices and offers you put away - the release notes you have seen, an update card, the first-run setup, a mockup - so the same one is not shown to you again.", "Local storage; the first-run setup one in session storage.", "A newer version comes out, the window closes (the setup one), or you clear the app's storage."],
              ["`trhai.storage-consent.v1`", "Your answer to the question about optional settings, with the version of this text and the time you answered.", "Local storage.", "You change it, or clear the app's storage."]
            ]
          }
        ]
      },
      {
        id: "optional",
        heading: "4. Settings that remember a choice",
        blocks: [
          { kind: "p", text: "These are kept only if you allow it. If you do not, the app works the same, and forgets these choices when it closes." },
          {
            kind: "table",
            caption: "Settings that remember a choice",
            head: ["Name", "What it remembers", "Kept in", "Until"],
            rows: [
              ["`trhai.chat.conversation.v1`", "Which conversation was open, so the chat reopens where you left it.", "Local storage.", "You start another conversation, or change this choice."],
              ["`trhai.accent.v1`, `trhai.backdrop.v1`", "Your accent colour and background.", "Local storage.", "You change them, or change this choice."],
              ["`trhai.os.slim.v1`, `trhai.home.layout.v1`", "Whether the sidebar is narrow, and how the Home screen is arranged.", "Local storage.", "You change them, or change this choice."],
              ["`trhai.personality.v1`, `trhai.marketplace.v1`", "The assistant personality and the agent you chose.", "Local storage.", "You change them, or change this choice."],
              ["`trhai.voice.v1`, `trhai.speech.enabled.v1`, `trhai.cues.enabled.v1`", "The voice you picked, and whether replies are spoken and sounds are played.", "Local storage.", "You change them, or change this choice."]
            ]
          }
        ]
      },
      {
        id: "change",
        heading: "5. Changing your choice",
        blocks: [
          { kind: "list", items: [
            "The first time you open TRH AI you are asked whether to remember these choices: yes, or only what the app needs. Until you answer, choices are kept for the session only.",
            "**Settings, Privacy and consent, Browser storage** shows your answer and lets you change it at any time. Saying no removes the remembered choices that are already stored.",
            "**Settings, Privacy and consent, Erase** removes the data TRH AI keeps for you; clearing the app's storage in Windows (delete the app's data folder) removes everything in the window's storage."
          ] }
        ]
      },
      {
        id: "others",
        heading: "6. Other companies",
        blocks: [
          { kind: "p", text: `${product} loads no scripts, fonts, images or other content from other companies' servers when it is open, so none of them can set cookies or keep storage in its window. Its fonts are stored with the app. If you ask the assistant to open a website in your own browser, that is your browser, with its own cookies, and not TRH AI.` },
          { kind: "note", tone: "review", text: "Whether storing the second group of settings needs consent depends on the law where the person lives (some treat settings the person chose, kept on their own device, as not needing it). The consent box is built so either answer works; a lawyer should say whether to keep showing it." }
        ]
      }
    ]
  };
}
