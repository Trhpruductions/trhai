// Stands in for the Electron script that frameRenderer.ts runs, in tests: it
// reads the manifest it is given and does what FAKE_RENDER says, so the real
// spawning, timeout and checking around it can be tested without Electron.
//
//   ok       writes every page as a small PDF and every frame as a small file
//   readable writes every page as a real one-page PDF holding the page's own text, as a print of it would
//   garbage  writes something that is not a PDF
//   partial  writes only the first page
//   crash    says something on stderr and exits with code 3
//   hang     never finishes
//
// FAKE_RENDER_LOG, when set, names a file that gets the HTML of each page as it
// was handed over, to show it reached the renderer.
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
const mode = process.env.FAKE_RENDER ?? "ok";

/** The text on a page of HTML, a line to each tag. */
function textOf(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .split("\n").map((line) => line.trim()).filter(Boolean);
}

/** A small, valid, one-page PDF with these lines of text in it (the same as tinyPdf in pdf.ts, which a plain node cannot import). */
function tinyPdf(lines) {
  const escape = (text) => text.replace(/[()\\]/g, (mark) => `\\${mark}`);
  const content = ["BT", "/F1 12 Tf", "14 TL", "72 720 Td", ...lines.map((line) => `(${escape(line)}) Tj T*`), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const table = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${table}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

if (mode === "crash") {
  process.stderr.write("the window process crashed\n");
  process.exit(3);
} else if (mode === "hang") {
  setInterval(() => {}, 1000);
} else {
  const results = [];
  const seen = [];
  for (const [position, pdf] of (manifest.pdfs ?? []).entries()) {
    const html = readFileSync(pdf.htmlPath, "utf8");
    seen.push({ index: pdf.index, html });
    if (mode === "partial" && position > 0) continue;
    writeFileSync(
      pdf.outputPath,
      mode === "garbage" ? "this is not a pdf" : mode === "readable" ? tinyPdf(textOf(html)) : `%PDF-1.4\n% a page ${pdf.index}\n%%EOF\n`
    );
    results.push({ index: pdf.index, ok: true });
  }
  for (const frame of manifest.frames ?? []) {
    writeFileSync(frame.outputPath, "a frame");
    results.push({ index: frame.index, ok: true });
  }
  if (process.env.FAKE_RENDER_LOG) writeFileSync(process.env.FAKE_RENDER_LOG, JSON.stringify(seen));
  writeFileSync(manifest.resultsPath, JSON.stringify(results));
}
