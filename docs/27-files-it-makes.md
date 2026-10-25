# Files it makes

Ask the assistant for a file and it makes a real one - the kind you can open in
Word, print, attach to an email or hand to someone - on this PC, with no account,
no key and nothing leaving the machine. Each kind of file is a tool the
assistant can use (see the **Tools** screen); this page says what each one does,
where its files go and how they are checked.

## Documents - `make_document`

A Word document (`.docx`), a PDF, a web page (`.html`), a Markdown file or a
plain-text file, made from text the assistant writes. Ask for it the way you
would ask a person:

- "Make me a Word document of the meeting notes."
- "Turn that into a PDF."
- "I need a resume - Word and PDF."
- "Put the invoice in my Downloads folder as a PDF."

Asking for words with no file in the request ("write me a cover letter") gets
the words in the reply, not a file. Name the file (Word, PDF) or one of the things
people keep as files - a resume, invoice, report, proposal, contract, agenda,
handout - and the tool is offered (`wantsAFileMade` in `actionIntent.ts`).

### What the text can hold

The assistant writes the whole document in Markdown, and every format is drawn
from the same reading of it (`markdown.ts`), so the Word file and the PDF agree:

headings (`#` to `######`), paragraphs, **bold**, *italic*, ~~strike~~, `code`,
links, bullet and numbered lists (nested too), checklists (`[ ]` and `[x]` show
their boxes), tables (with column alignment), quotes, code blocks, rules and page
breaks (a line with only `\pagebreak`). A single line break inside a paragraph is
kept as a line break, so an address or a letter written a line at a time comes out
as written. Nothing is passed through as HTML: what looks like a tag is shown as
text (only `<br>` is a line break), and a link that is not to the web, a mail
address, a phone number or a place in the page is left as text.

### How each format is made

| Format | How | Notes |
| --- | --- | --- |
| Word (`.docx`) | written by hand: a zip of XML (`zipWriter.ts`, `docxWriter.ts`), no library | real styles (Heading 1-6, lists with numbering, table grid), page size and margins, document properties |
| PDF | printed by TRH AI's own window - the Electron that draws video frames - with JavaScript off and every request that is not for a local file refused (`frameRendererElectron.mjs`) | tagged, with the headings as bookmarks; paper from the page's own `@page` rule |
| Web page | one self-contained `.html` file (`documentHtml.ts`) | prints well too |
| Markdown / text | the text as written / a plain rendering with headings underlined, tables in columns and link addresses written out | text has Windows line ends |

Paper is A4 or Letter: the one asked for, otherwise the one this PC's own country
uses (`paperForLocale`).

### Where files go

In the workspace's `documents` folder, named for the title (`Quarterly Report.docx`).
A file that is already there is **never replaced**: the next one is `Quarterly Report (2).docx`,
and the files of one document - the Word file and its PDF - always share the same number.

The assistant can save somewhere else when you say where: a folder in the workspace,
or - with machine access on - `Desktop`, `Downloads`, `Documents`, `Pictures`, `Music` or
`Videos` as you would say them, or a full path. The real place is looked up (on a PC that backs its
Desktop up to OneDrive, that is `OneDrive\Desktop`; `knownFolders.ts`). Without machine access,
or on an unattended run, anything outside the workspace is refused with the usual message, and
system folders are refused even with it.

### Checked before it is reported

Every file is read back with the reader TRH AI uses on documents it is given
(`documentText.ts`), and the document's own first and last words must be found in
what comes back:

- a Word file or PDF that **cannot be read back is removed**, and the reply says so;
- one that reads but does not show the document's words is **kept, with a note** to
  open and look at it before sending it on;
- a format that fails does not stop the others: ask for Word and PDF, and a PC that cannot
  print PDFs still gets the Word file, with the PDF named as the thing that could not be made;
- only when nothing could be made is the whole request a failure, and nothing is left behind.

The reply names each file by where it is, with the page count for a PDF (counted on reading it
back), and the assistant is told to give that to you. `make_document` is one of the tools whose
own result line is carried into the final answer (`mutatingTools` in `agentLoop.ts`), so a
file is not reported by paraphrase.

The file tools (`write_file`, `edit_file`) refuse a `.docx` or `.pdf` target - plain text saved
there leaves a file nothing can open - and now say to use `make_document`.

### Limits

Up to 300,000 characters of text (about fifty thousand words) in one document. Images are not
placed in documents yet. Word files are written to the Office Open XML format and read back with
this app's own reader and with python-docx while building it; they have not been opened in Microsoft
Word itself.

## Tests

`markdown.test.ts`, `zip-writer.test.ts` (read back with the system's `tar`), `document-files.test.ts`
(Word files read with the app's own reader and checked well-formed, HTML whitelisted tag by tag),
`document-maker.test.ts` (names, formats, paper, checking, partial failure), `make-document-tool.test.ts`
(when the tool is offered, where it may write, what it refuses), `known-folders.test.ts`, and
`pdf-render.test.ts`: the printing and checking around Electron run against a stand-in script, and with
`TRHAI_REAL_ELECTRON=1` two tests print with the real Electron - one checks a multi-page A4 file reads
back, the other that a page which tries to run a script or reach the network can do neither.
