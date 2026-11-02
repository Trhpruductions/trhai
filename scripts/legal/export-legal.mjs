// Writes TRH AI's legal texts out as files, for a website and for a lawyer: one Markdown
// file and one standalone HTML page per text, under docs/legal. The texts come from the
// shared package's registry, the same one the app shows, so a page here can never differ
// from the one in the app. Run after `npm run build -w @ascend/shared`:
//
//   node scripts/legal/export-legal.mjs
//
// A test (packages/shared/tests/legal-texts.test.ts) fails when docs/legal is out of date.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftNotice, escapeHtml, legalBodyToHtml, legalDocuments, legalShortTitle, legalTextsReady, legalToMarkdown } from "../../packages/shared/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "docs", "legal");
mkdirSync(out, { recursive: true });

const draft = !legalTextsReady();
const docs = legalDocuments();

export function pageHtml(doc, all) {
  const body = legalBodyToHtml(doc, { showReviewNotes: draft, link: (id) => `${id}.html` });
  const nav = all.map((other) => `<a href="${other.id}.html"${other.id === doc.id ? ' aria-current="page"' : ""}>${escapeHtml(legalShortTitle(other.id))}</a>`).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)} - TRH AI</title>
<style>
  :root { color-scheme: light dark; --ink: #1b2430; --paper: #ffffff; --line: #d9e0ea; --accent: #0b6bcb; --mark: #fff3c4; }
  @media (prefers-color-scheme: dark) { :root { --ink: #e6edf7; --paper: #0b1220; --line: #27344a; --accent: #7fc4ff; --mark: #4d3b00; } }
  body { margin: 0; font: 16px/1.6 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
  .wrap { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  nav.texts { display: flex; flex-wrap: wrap; gap: .4rem 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
  nav.texts a[aria-current] { font-weight: 700; text-decoration: none; }
  a { color: var(--accent); } a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  h1 { font-size: 1.8rem; line-height: 1.2; } h2 { font-size: 1.25rem; margin-top: 2rem; }
  .meta, .summary { color: inherit; } .meta { opacity: .75; }
  aside.note { border-left: 4px solid var(--accent); padding: .6rem .9rem; margin: 1rem 0; background: rgba(127,127,127,.08); }
  aside.note.review { border-color: #c77d00; }
  .draft { border: 1px solid #c77d00; padding: .7rem .9rem; border-radius: 6px; background: var(--mark); color: #1b2430; }
  mark.open { background: var(--mark); color: inherit; padding: 0 .3em; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .95rem; }
  caption { text-align: left; font-weight: 600; padding: .4rem 0; }
  th, td { text-align: left; vertical-align: top; padding: .5rem .6rem; border-top: 1px solid var(--line); }
  thead th { border-bottom: 2px solid var(--line); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: .9em; }
  .foot { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .9rem; opacity: .8; }
</style>
</head>
<body>
  <div class="wrap">
    <nav class="texts" aria-label="Legal texts">
      ${nav}
    </nav>
    <main>
${draft ? `      <p class="draft" role="note">${escapeHtml(draftNotice)}</p>\n` : ""}${body}
    </main>
    <p class="foot">Generated from TRH AI's own text registry by scripts/legal/export-legal.mjs. The same text is shown inside the app under Settings, Legal.</p>
  </div>
</body>
</html>
`;
}

for (const doc of docs) {
  writeFileSync(path.join(out, `${doc.id}.md`), legalToMarkdown(doc, { showReviewNotes: draft, link: (id) => `${id}.md` }));
  writeFileSync(path.join(out, `${doc.id}.html`), pageHtml(doc, docs));
}
writeFileSync(path.join(out, "README.md"), [
  "# TRH AI legal texts",
  "",
  "Generated files: do not edit them here. The texts live in `packages/shared/src/legal/` and the facts the",
  "business supplies in `packages/shared/src/legalFacts.ts`. Rebuild the shared package and run",
  "`node scripts/legal/export-legal.mjs` to refresh these copies; a test fails when they are stale.",
  "",
  ...docs.map((doc) => `- [${doc.title}](${doc.id}.md) ([page](${doc.id}.html))${doc.version ? ` - version ${doc.version}` : ""}`),
  ""
].join("\n"));
console.log(`wrote ${docs.length * 2 + 1} files to ${out}${draft ? " (draft: review notes included)" : ""}`);
