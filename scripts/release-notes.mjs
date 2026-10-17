// Writes the GitHub release page's text for a version, from its note in
// packages/shared/src/releaseNotes.ts (built: npm run build --workspace
// @ascend/shared). The Release workflow publishes this instead of a list of
// pull requests, because installed copies show it when offering the update.
//
//   node scripts/release-notes.mjs <version> <outFile> [--candidate]
import { writeFileSync } from "node:fs";
import { releasePageText } from "@ascend/shared";

const [version, outFile, flag] = process.argv.slice(2);
if (!version || !outFile) {
  console.error("usage: node scripts/release-notes.mjs <version> <outFile> [--candidate]");
  process.exit(2);
}
const text = releasePageText(version, { candidate: flag === "--candidate" });
if (!text) {
  console.error(`No note for ${version} in packages/shared/src/releaseNotes.ts. Add one before releasing it.`);
  process.exit(1);
}
writeFileSync(outFile, `${text}\n`, "utf8");
console.log(text);
