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

## Spreadsheets - `make_spreadsheet`

An Excel workbook (`.xlsx`), a CSV file, or both, from data the assistant writes. Ask for
one the way you would ask a person: "make me an Excel spreadsheet of my expenses", "I need
a budget", "put those rows in a spreadsheet and a CSV". The tool is offered for a
spreadsheet named with something being made, or a budget, timesheet, gradebook, ledger or
payroll being created (`wantsASpreadsheetMade`); a table to read in the reply needs no
file, and a bare "csv" is not a trigger (`write_file` makes a plain `.csv`).

### What the data can be

CSV (commas, semicolons, tabs or bars - found from the lines), Markdown tables, or JSON
rows, with a heading (`## Costs`) above each for a sheet's name - CSV under headings gives
a sheet for each. Every cell is read for what it is (`sheetData.ts`): numbers (with the
commas a person writes), percentages (`12%`), money (`$1,200.50`, `($5.00)`, `£1,000`),
dates (`2026-03-04`, `4 March 2026`, and `3/4/2026` as this PC's country reads it), true
and false, and formulas (a cell that starts with `=`). What only looks like a number - a
zip code, `007`, a card or phone number - stays text, and a leading apostrophe says "text"
as in a spreadsheet program.

### Formulas

A formula is read and worked out (`formulas.ts`: arithmetic in a spreadsheet's order, cell
ranges, other sheets, and the usual SUM, AVERAGE, IF, COUNTIF, SUMIF, ROUND, AND and the like), and its answer is written
beside it so that a viewer that does not calculate - a phone's preview, a file explorer - still shows
numbers; the workbook is marked to be worked out again when a spreadsheet program opens it. What it
does not work out (TODAY, a lookup) is kept as a formula with no answer written.

A total is shown the way the cells it adds up or multiplies are shown - amounts of money give money, shares give a
percentage - as a spreadsheet program does when a formula is typed in; a ratio, a comparison or text is left plain. In a CSV a
formula may have commas and quotes of its own (`=IF(A2>0,"x","y")`) without being quoted: it ends at the comma that is outside its brackets.

A formula that cannot be read - semicolons for commas, an unknown function - or that reaches out of
the file (`WEBSERVICE`, `HYPERLINK`, `CALL`, a DDE call) is **kept as the text it was, with the
reason**, rather than written into a file a spreadsheet program would complain about; the reply says
so. One that comes to an error (`#DIV/0!`) or refers to itself is said to, too.

### The files

The workbook is written by hand like a Word file (`xlsxWriter.ts`): a bold, shaded header row that is
frozen and filtered, columns sized to what is in them, long text wrapped, real number, percent, money and
date formats, one sheet to each table. A CSV is UTF-8 with the mark Excel itself writes, holds what a
spreadsheet shows, and any text that would run when it is opened in a spreadsheet program (starting
with `=`, `+`, `-` or `@`) gets a leading apostrophe. A CSV holds one sheet; with more, the first is
written and the reply says so.

Named for the title, in the `documents` folder or where the user says, never replacing a file, exactly as
for documents (`madeFileNames.ts`, `knownFolders.ts`).

Every file is **read back and compared with what was meant to be in it, cell by cell** (`xlsxReader.ts`:
shared strings, the styles that make a number a date, shared formulas, text of every kind): a cell that
comes back different is named in the reply and the file is not called checked.

### Reading spreadsheets

The same reader gives the assistant the cells of any `.xlsx` it is given (a heading for each sheet, the
rows tab-separated, a formula after its answer), so `read_file`, summarising, the knowledge base and the
Files preview all read a spreadsheet; `write_file` refuses an `.xlsx` and says to use `make_spreadsheet`.

## Opening what it made

A reply that made a file shows it as a card with **Open** (in the program it belongs
to: Word, the PDF reader) and **Show in folder** (Explorer, with the file selected).
The Files screen has the same two buttons on every file, **Open folder** for the folder
in view, and shows the words of a PDF, Word or PowerPoint file in its preview.

- `POST /v1/files/open { path, action: "open" | "reveal" }` (`fileOpenRoutes.ts`): JSON
  only; only from this PC (the file appears on this PC's screen, so another device that
  has been let in is refused); not behind the paywall; the path must be inside the
  workspace and exist.
- What is opened: documents, pictures, sound and video (`openableExtensions` in
  `openInSystem.ts`) - never anything that could run (`.exe`, `.bat`, `.ps1`, `.lnk`, ...)
  and no web page, which can run script when opened from disk. Anything in the workspace
  can be shown in its folder.
- On Windows `explorer.exe <path>` opens and `explorer.exe /select,"<path>"` selects, with
  the quotes round the path alone and the arguments sent as they are (tried for real with a
  path that has spaces, an ampersand and brackets in it).
- The files a turn made come back with its reply as `files` (from `/v1/assist`, and in the
  stream's `done` event) through a hand-off keyed by conversation (`madeFiles.ts`). A
  conversation opened again finds them in the reply's own result lines. A file made outside
  the workspace is told by its whole path and has no button.
- `GET /v1/files/document?path=` gives the words of a PDF, Word or PowerPoint file (the first
  200,000 characters) for the preview, read the way the assistant reads documents.

## Tests

For spreadsheets: `formulas.test.ts` (reading, refusing and working out formulas), `sheet-data.test.ts` (what a cell is, CSV, tables, JSON),
`xlsx.test.ts` (the workbook's parts, and a workbook of the kind Excel saves read back), `spreadsheet-maker.test.ts`, `make-spreadsheet-tool.test.ts`.
The workbook was also read with openpyxl while building it: values, formulas and their answers, formats, bold shaded headers, frozen panes,
filters and widths. For documents and the rest: `markdown.test.ts`, `zip-writer.test.ts` (read back with the system's `tar`), `document-files.test.ts`
(Word files read with the app's own reader and checked well-formed, HTML whitelisted tag by tag),
`document-maker.test.ts` (names, formats, paper, checking, partial failure), `make-document-tool.test.ts`
(when the tool is offered, where it may write, what it refuses), `known-folders.test.ts`, and
`open-in-system.test.ts`, `file-open-routes.test.ts` (who may ask, what comes back, and that the reply carries the file),
`made-files.test.ts`, `document-preview-routes.test.ts`, the web's `files.test.ts`, and
`pdf-render.test.ts`: the printing and checking around Electron run against a stand-in script, and with
`TRHAI_REAL_ELECTRON=1` two tests print with the real Electron - one checks a multi-page A4 file reads
back, the other that a page which tries to run a script or reach the network can do neither.
