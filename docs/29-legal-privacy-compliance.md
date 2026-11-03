# Legal, privacy, security and accessibility: where TRH AI stands

Written 2026-11-02, from the owner's brief of 2026-11-01 (twenty requirements) and three
read-only audits of the code run the same day (security, accessibility, outside services
and licences). This is the honest state, not the aspiration: each requirement below is
COMPLETE, PARTIALLY COMPLETE, NOT IMPLEMENTED, REQUIRES BUSINESS INFORMATION or REQUIRES
LEGAL REVIEW, with what was done and what is left. Nothing here claims a certification or a
legal compliance that nobody independent has confirmed.

## Where things live

| What | Where |
|---|---|
| The legal texts, as data | `packages/shared/src/legal/` - `privacy.ts`, `terms.ts`, `refunds.ts`, `storage.ts` (cookies), `ai.ts`, `business.ts`, `services.ts`; the registry in `index.ts`; the reading, Markdown and HTML renderers in `model.ts` |
| The facts only the business can supply, and each text's version | `packages/shared/src/legalFacts.ts` - every unsupplied fact is `null`, and shows in the texts as "to be supplied" |
| The texts in the app | Settings, Legal (`LegalPanel.tsx`); over the sign-in screen and the paywall (`LegalDialog.tsx`, `useLegal`) |
| What a person agreed to, the copy, the erasure | `apps/api/src/services/privacy.ts`, `privacyRoutes.ts`; Settings, Privacy and consent (`PrivacyPanel.tsx`) |
| Consent at sign-up | `registrationConsents` in `privacy.ts`, checked in `/v1/auth/register`; the boxes in `SignInScreen.tsx` |
| The browser-storage question | `apps/trhai-web/src/lib/storageConsent.ts`, `StorageConsentBanner.tsx` |
| Copies for a website | `docs/legal/*.md` and `*.html`, written by `scripts/legal/export-legal.mjs`; a test fails when they are stale |
| The audits' full findings | the session transcript of 2026-11-01; the actionable items are listed under "Security" and "Accessibility" below |

## The twenty requirements

| # | Requirement | Status | What was done, and what is left |
|---|---|---|---|
| 1 | Privacy Policy | **PARTIALLY COMPLETE - REQUIRES BUSINESS INFORMATION, REQUIRES LEGAL REVIEW** | Written from what the code does, with every statement checked against it: what is stored (file by file, with retention), everything that leaves the PC (seven cases, each with what it sends and how to stop it), what TRH Development holds, how long, protection without overclaiming, rights, children, where data goes. Shown in the app and exported. Open: the privacy contact, the business's country, the sales-record retention, the minimum age; a lawyer must settle the controller question, the rights list and deadlines, and transfer safeguards. |
| 2 | Terms of Service | **PARTIALLY COMPLETE - REQUIRES BUSINESS INFORMATION, REQUIRES LEGAL REVIEW** | Eighteen sections written for the product as it is (local software, trial, offline license key, optional accounts). AI answers are stated as not professional advice. Open: minimum age, governing law, dispute venue, support email, what each plan allows; warranty and liability wording must be adapted by a lawyer. |
| 3 | Refund Policy | **PARTIALLY COMPLETE - REQUIRES BUSINESS INFORMATION, REQUIRES LEGAL REVIEW** | States the real payment model (free trial, license key, payment on a provider's checkout page, never in the app), the cases always put right (duplicate, failed, billing error, unauthorized), the procedure, and that a refunded key must be removed by the person because it cannot be revoked. No refund window was invented: `refundWindowDays` is the owner's to set, and consumer-law rights are flagged for a lawyer. |
| 4 | Cookie Policy | **COMPLETE as a text; REQUIRES LEGAL REVIEW** | TRH AI sets no cookies (verified: nothing in the service, the interface or the shell sets or reads one). The "Cookies and browser storage" text lists every item kept in the window's storage - 10 the app needs (including notices put away, so the same one is not shown again), 10 remembered choices - with what each holds, where and for how long; a test fails if the code uses a key the text does not name, or the text names one the code does not use. |
| 5 | Cookie consent banner | **COMPLETE** | A banner asks once whether remembered choices may be kept; "Yes" and "Only what is needed" have equal weight; a third button opens Settings. Until an answer, and after a no, the 10 optional items live in memory for the session and are never written (`optionalStorage()`); a no also removes any already kept. The answer and its date are shown and changeable under Settings, Privacy and consent. The texts link from the banner. |
| 6 | Form consents | **COMPLETE** | Sign-up has one box per text (Terms; Privacy Policy acknowledgment; the age box appears only once a minimum age is set), each opening the text. The service refuses registration without them (400), and refuses an agreement to a version that is not the current one (409: a page left open while a text changed). Each agreement is kept with the account as text, version, time and where it was given; shown under Settings, Privacy and consent. A changed text prompts the signed-in person to read and agree again; nothing is agreed by closing the prompt. There is no marketing consent because there is no marketing: the app sends no email. |
| 7 | Data minimisation | **PARTIALLY COMPLETE** | Done: the access log no longer records the query part of an address (guest session ids, search words, page addresses, file names); a command is logged as its program and length, never the line; logs rotate at 2 MB and are deleted after 30 days. Reviewed and kept as is, each with a reason in the Privacy Policy: automatic memory capture of facts a person states (it is the feature; deletable), the trial-start marker (holds no personal data), finished-work history (deletable). Left: a deleted memory's text stays in the "forgotten" note until erased or restated (said in the policy; a one-way fingerprint would be better); the license key payload holds the buyer's email in signed, unencrypted form inside an encrypted file. |
| 8 | Third-party SDK and API audit | **COMPLETE as an inventory; REQUIRES LEGAL REVIEW for licences** | Every outbound request found and listed (GitHub release check and downloads, Hugging Face downloads, DuckDuckGo search and connectivity check, pages the user asks for, the user's own mail server, the checkout page). No analytics, tracking or crash reporting exists. Every runtime npm dependency's licence read (all permissive; sharp's Windows binary carries LGPL parts). Downloaded components and their licences listed in the "Services and licences" text; a test ties the voice and model rows to the install records. Owner decisions: four of five voices and two models are not cleared or not licensed for commercial use; the ffmpeg build is GPL; llama.cpp, CUDA runtime and eSpeak NG licences are not yet in the install records. Not measured: whether Chromium's built-in spell-check contacts Google. |
| 9 | No dark patterns | **PARTIALLY COMPLETE** | Consent buttons are plain and equal; nothing is pre-ticked; cancelling is not hidden (there is nothing to cancel in the app); erasure is a clear, labelled path; "Not now" on the consent prompt agrees to nothing. Left for review: the required-update window restarts the app on a two-minute countdown with no postpone (accessibility finding M9); whether that is acceptable is the owner's call. |
| 10 | No hidden fees | **COMPLETE as far as the app is concerned; REQUIRES BUSINESS INFORMATION** | The app charges nothing and has no payment screen. The checkout page (not yet configured: `checkoutUrl` and `priceText` are null) must show price, taxes, period and renewal before payment; the Terms and Refund Policy say so and the paywall links to both. No paid feature was added. |
| 11 | No fake reviews | **COMPLETE** | The interface has no testimonials, ratings, user counts or satisfaction figures, and none were added. |
| 12 | No unsupported claims | **PARTIALLY COMPLETE** | Corrected: "nothing about you is sent" on the Updates and Network screens (GitHub sees the internet address and version); "SECURE SIGN IN" eyebrow. Verified accurate and kept: "No email is ever sent", "no cloud AI" (true unless `TRHAI_ENGINE_URL` is set, which the policy states), "stored encrypted" (with its limits stated beside it). Experimental features are named in "How TRH AI uses AI". An AI disclaimer is in the Terms and that text. Left: a review of every remaining sentence of marketing copy on the sign-in hero and release notes by the owner. |
| 13 | Image alt text | **COMPLETE** | Verified by audit: icons are hidden from screen readers, decorative canvases and art are hidden, charts and meters have names, 236 buttons checked and none lacks a name source, and the sidebar's buttons keep their name when the label is hidden below 1100 px (an `aria-label` on each). Accessibility follow-up: the copy buttons (code blocks, recovery codes) say their result through a status region, and an attached image's name says it is an attachment. One limit stays: an attached image is described by its file name, because nothing in the app can describe a picture unless a vision model is loaded. |
| 14 | Colour contrast | **COMPLETE (dark theme; measured, not seen)** | Accessibility follow-up: the quietest text token is `#7f8ea8` (4.57:1 at worst across the real surfaces, the brightest art included), a field's edge is its own token at 3:1, a focused field's edge is the accent itself, every accent line reaches 3:1, red badges carry ink rather than white, the hints under the command bar use the louder grey, the sign-in screen's faint words and placeholders pass, and the voice picker's accent words use the lighter accent. `apps/trhai-web/tests/contrast.test.ts` computes the ratios from the stylesheets' real tokens, so they cannot drift back. Forced colours (Windows high contrast) have their own rules: edges, chosen rows, switches and focus drawn in system colours, the art hidden. No light theme exists; none was asked for. |
| 15 | Keyboard navigation | **COMPLETE** | Accessibility follow-up: every dialog (paywall, required update, setup, What's new, the command palette, the phone's workspace sheet, the legal texts, the consent prompt) holds the keyboard, makes the page behind it inert, closes on Escape where a button would, and gives focus back; the two menus take the arrows, Home and End, and Escape returns to their button; the three choice groups (browser storage, accent colour, Phone Link's phone) are radio groups with one tab stop and the arrows; opening a workspace names the tab after it and puts the keyboard on it; the single-key "/" shortcut has an off switch under Settings, Keyboard, beside a list of every shortcut (WCAG 2.1.4). Nothing was tried in a real screen reader. |
| 16 | Business information | **REQUIRES BUSINESS INFORMATION** | A Business information page exists and shows the operator name, the official download address and checksums, and how payments work. Every other detail - legal entity, registration number, postal address, country, website, support, privacy and business emails - is an open item until the owner supplies it in `legalFacts.ts`. Nothing was invented. |
| 17 | Age restrictions and children's privacy | **REQUIRES BUSINESS INFORMATION, REQUIRES LEGAL REVIEW** | The mechanism is built: when `minimumAge` is set, the sign-up form gains an age box, the service requires it, and the Terms, Privacy Policy and consent records carry it; no date of birth is collected. The age itself is undecided. The texts say plainly that an age box is not COPPA compliance, and what a parent can do. |
| 18 | Unsubscribe | **NOT APPLICABLE** | TRH AI sends no promotional or marketing email and has no mailing list; the service sends email only through the person's own account, at their request. Nothing to unsubscribe from exists; if a newsletter is ever started, it needs its own unsubscribe before the first send. |
| 19 | Asset licensing | **PARTIALLY COMPLETE; REQUIRES LEGAL REVIEW** | Recorded: the four fonts (OFL 1.1, notices shipped), the icon paths (written in the repo), the libraries. Found: the background picture and the only logo file carry metadata naming an AI image model as their maker, and the installed app icon still reads "Ascend AI"; the repo has no LICENSE file; there is no consolidated third-party notices file in the installer. These are owner decisions, stated in the "Services and licences" text. |
| 20 | Data deletion | **COMPLETE** | Settings, Privacy and consent: choose what to erase (own data; the copy's shared settings where the person owns the copy; the license key; the account), see exactly what that is with the real counts, type a word, and - with an account - give the password. The service removes the records from each store and writes the files again, cleans the backup copy of the accounts file, takes the address out of the change record, ends every session, and reports step by step what was and was not removed, including what is kept (workspace files, the trial marker, downloaded software) and why. A record of the request (date, scope, random id - no name or email) is kept 24 months. Deleting is never blocked by a lapsed trial. Guessing the password at this route is rate-limited. |

## Also built: a copy of the data

Not one of the twenty, but asked for under "Technical implementation": one file with
everything held for the person, in plain words, that lists what it leaves out (passwords
and codes exist only as hashes; the email password is never written to a file; workspace
files are the person's own). Available signed in or not, and when the trial has ended.

## Security

From the read-only audit of 2026-11-01. Fixed in the legal and privacy change (#145): the access log and command
log (finding F9), deletion behind the paywall (F6), no account deletion or export (F8).
Fixed in the security follow-up change, each with its own test; `25-security.md` ("The
second review") says what changed and why it mattered:

| Finding | What | Fix |
|---|---|---|
| F2 | On a shared copy (`TRHAI_AUTHORITY=on`), reads and many writes had no sign-in check. | `requireSignInOnSharedCopy` and `requireOwnerForCopyChangesOnSharedCopy` (`access.ts`): everything but what signing in needs answers only a signed-in account, and the license, the email account, installs, the network check, the shared preferences and opening a file on the host are the owner's. With `ASCEND_NETWORK_ACCESS=on` another device still has to carry the access key, as before; that key is the owner's own, so no sign-in is asked of it. |
| F3 | Non-GET requests were not refused by Origin, so a page on another loopback port could trigger arm/disarm, downloads, the SMTP test, blind fetches. | `requestOrigin.ts`: a request whose `Origin` is not the app's, or marked `Sec-Fetch-Site: cross-site`, is refused (403) before anything else runs, whatever its method; the two web-fetch routes also refuse to be embedded. |
| F4 | The saved SMTP password was reused when the host changed, and the test route logs in to that host. | `emailAccount.ts`: the password is reused only for the same address on the same host, port and sign-in name. |
| F5 | `/v1/world` returned the newest steps of every session with command text. | `worldState.ts`: a step shows its kind, status and time; a command's label is "Ran a command"; details and artifacts stay in their session. |
| F10 | `.docx` reading had no decompression cap (a 695 KB file inflated to 200 MB). | `documentText.ts`: a part unpacks to at most 64 MB, and an archive has at most 4,096 parts. |
| F11 | The web-fetch address check resolved DNS once and missed some private ranges; the body read had no deadline. | `webFetch.ts`: every address of a name is checked, more ranges count as private, the connection is pinned to a checked address and never resolves the name again, and the time limit runs to the last byte. |
| F14 | No Content-Security-Policy or Referrer-Policy on the interface. | `next.config.ts`: every page carries a policy that allows this PC's addresses only (`localhost` and `127.0.0.1`; a policy cannot name `::1`, and nothing addresses it), forbids being framed, and `Referrer-Policy: no-referrer`, `X-Content-Type-Options`, `X-Frame-Options` and `Permissions-Policy` beside it. The token stays in web storage: the service reads it from the `Authorization` header alone and sets no cookie, so nothing rides along with a request the page did not make. |
| F17 | Stores kept 500 keys and dropped the oldest; many guest ids could push out a real account's data. | `storeEviction.ts`: the oldest anonymous key goes; an account's never does. |
| F20 | Child processes inherited the whole environment. | `childEnv.ts`: TRH AI's own keys are left out of a command's or an app's environment. |
| F22 | 500 errors returned raw messages. | `errorReply.ts`: one sentence to the caller; the message goes to the service's log. |
| - | ffmpeg read uploaded songs with every protocol allowed (not in the audit's list). | `musicVideo.ts`: `-protocol_whitelist file,pipe` on every run. |

Still open:

| Finding | What | Decision or fix |
|---|---|---|
| F1 | Machine access is on by default; `fetch_url` and `web_search` run without confirmation, so text in a page or file can steer the assistant. Docs 15 and 25 said off; corrected. | Owner's decision whether a new install should start off. The texts say what the code does today. |
| F21 | The engine key is on the engine's command line and in the file beside its process id. | Left for a later change: a second copy of the app on this PC finds the running engine and its key through that file, so moving the key off the command line is a new hand-over between copies. Both are readable only by a program running on this PC. |

Verified good and safe to cite: loopback-only listening with a Host allowlist, CORS limited
to the web port, helmet, scrypt passwords with timing-safe checks, hashed session tokens with
revocation on password change and recovery, rate limits on sign-in paths, AES-256-GCM at
rest with a lock against a wrong key, workspace confinement with realpath checks, pinned
downloads by size and SHA-256, no SQL anywhere, no cookies (so no ambient-credential CSRF),
Markdown rendered as React nodes with a scheme allowlist, a sandboxed Electron window.

## Accessibility

From the audit of 2026-11-01 (WCAG 2.2 AA target) and the follow-up change that acted on it.
Nothing was measured in a real screen reader: the findings came from reading the code and
computing contrast against the real art, and the fixes were checked the same way (the contrast
test) and by hand in a browser. The new screens in the legal change were written to the
audit's bar: labelled controls, real headings, named tables with row and column headers, a
focus-trapping dialog, errors in words (never colour alone), open items as text. The follow-up
brought the older screens to it; requirements 13, 14 and 15 say how. Still open: a pass with a
real screen reader (Narrator or NVDA), and a light theme, if one is ever wanted.

## Business information still required

Set these in `packages/shared/src/legalFacts.ts`; each shows as "to be supplied" until it is:

legal entity name; company registration number (or that there is none); business postal
address; country or state where the business is established; official website; support,
privacy and business email addresses; governing law; dispute venue; minimum age; payment
provider (and its privacy policy address); refund window in days (or none); years sales
records are kept.

Changing any of them changes the words of a text, so `legal-texts.test.ts` then asks for the
text's version date to be raised and its fingerprint recorded, and people who agreed to the
old words are asked to read the new ones.

## Legal questions needing a professional

- Who is the data controller for what is on a person's PC, and what a business user must
  do about other people's information they put in.
- The rights list, response deadlines and complaint authority for each place TRH AI is sold.
- Minimum age and children's privacy law (COPPA; GDPR Article 8 ages).
- Warranty disclaimer and liability limits under consumer law; governing law and venue.
- Consumer cancellation rights for digital content delivered at once, and any waiver.
- Whether a refunded key that cannot be revoked is handled acceptably by a promise to remove it.
- Retention periods chosen by the developer (30 days of logs, 24 months of erasure records).
- Whether storing remembered choices on the person's own device needs consent where TRH AI
  is sold, and so whether the banner should keep showing.
- Licences: the four voices and two models that are not cleared or not commercial; the GPL
  ffmpeg build downloaded by the app; LGPL parts of sharp; the repo's missing LICENSE file;
  the AI-generated brand images and the icon that names the old product.
- Transfers to US services (GitHub, Hugging Face, DuckDuckGo) and any safeguards needed.
- Whether machine access should be on by default.

## Deployment

Nothing here needs a server or a migration. The accounts file gains a `consents` field per
account on the next write (older accounts read as having none, and are asked to agree once);
a new `privacy-requests.json` holds the erasure record. After merging:

1. `npm run build -w @ascend/shared` then `node scripts/legal/export-legal.mjs` whenever a
   text or a fact changes; commit `docs/legal/`.
2. For a website, publish `docs/legal/*.html` (standalone pages) or the `.md` files.
3. Release as usual (`24-paywall-and-updates.md`); the texts and screens ship with the app.

## Tests for this change

`apps/api/tests/privacy.test.ts` (24: consent at sign-up and later, the copy, erasure in
every scope and on shared copies, the audit redaction, the record), `log-privacy.test.ts`
(4), `legal-services.test.ts` (2, texts against install records); `apps/desktop/tests/log-retention.test.ts`
(4); `apps/trhai-web/tests/privacy.test.ts` (5), `storage-consent.test.ts` (4);
`packages/shared/tests/legal-model.test.ts` (9), `legal-texts.test.ts` (5: versions pinned to
fingerprints, no template leftovers, links, open items, website copies in sync).
