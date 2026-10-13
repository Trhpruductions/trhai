// What changed, version by version, in words for the people using the app.
//
// This is what the "What's new" popup shows the first time a version runs on
// someone's PC, and what the Updates section lists. Newest first. Add an
// entry when the desktop app's version is bumped (apps/desktop/package.json
// is the product version; the installer is named after it).

export type ReleaseNote = {
  /** The product version, as in apps/desktop/package.json: "0.1.4". */
  version: string;
  /** ISO date the version was made. */
  date: string;
  title: string;
  /** One change per line, each a plain sentence. */
  notes: string[];
};

export const releaseNotes: ReleaseNote[] = [
  {
    version: "0.1.5",
    date: "2026-10-13",
    title: "Trial, license keys and update notices",
    notes: [
      "TRH AI now starts a 14-day free trial on a new PC. After that it asks for a license key; everything it holds stays readable, and a key unlocks it again.",
      "Settings has a Plan and billing section: where to buy, your plan, your key.",
      "A What's new notice like this one appears the first time a new version runs, and TRH AI tells you when a newer version is out, with the download.",
      "The Windows installer: TRH AI installs like any program, with no Node, npm or source tree needed.",
      "On a new PC, TRH AI offers to download its engine and a model suited to the PC, checks each against what its makers published, and carries on if the download is interrupted. Settings, Engine and models, adds and removes models later."
    ]
  },
  {
    version: "0.1.4",
    date: "2026-10-12",
    title: "Faster replies on small PCs and a full operations view",
    notes: [
      "Replies reuse what the model has already read, so a follow-up in the same conversation starts answering sooner.",
      "The System view shows everything TRH AI needs to run and whether each part is ready.",
      "The agents' world moved out into its own app, TRH World."
    ]
  }
];

/** Compare two dotted versions numerically: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.trim().replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The notes for `version` and every version before it, newest first, at most `limit` of them. */
export function notesUpTo(version: string, limit = 5, notes: ReleaseNote[] = releaseNotes): ReleaseNote[] {
  return notes
    .filter((note) => compareVersions(note.version, version) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, limit);
}
