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
    version: "0.1.7",
    date: "2026-10-25",
    title: "Make a music video from a song",
    notes: [
      "A new Music video screen turns a song into a finished music video. Drop in an MP3 (or a WAV, M4A or FLAC), paste the lyrics if you have them, and it draws a video the length of the song: a ring of bars that moves with the music, a glow on the beat, the title in the middle (or the song's own cover art), and the lyrics lit word by word as they are sung. Try the first 20 seconds, then make the whole thing in 1080p, or in the quicker 720p.",
      "It is drawn on your PC's processor, with no graphics card, no account and nothing sent anywhere, and the PC stays usable while it works. Finished videos are kept, with the song and the lyrics, in the music-videos folder of TRH AI's workspace, and any of them can be changed and made again.",
      "The lyrics are timed to the singing by listening to the song, which needs Listening installed (Settings, Engine and models). Without it, pasted lyrics are spread evenly over the song and the video says so. Singing over a band is hard to hear, so pasting the real lyrics works best.",
      "You can also ask TRH AI in a chat to make a music video from a song, and ask how it is getting on. It says when one has started, not that it is made, and the app tells you when it is done."
    ]
  },
  {
    version: "0.1.6",
    date: "2026-10-24",
    title: "Voice, listening and video install themselves",
    notes: [
      "TRH AI now installs its own voice, listening and video tools. The first-run screen offers them with the engine and a model, a copy that is already set up is offered them once when it opens after this update, and Settings, Engine and models, installs them at any time. Each file is checked against what its makers published before it is used.",
      "Narrated videos stay in step: each sentence now starts with its own scene, and a video no longer ends early when a scene lasts longer than its sentence.",
      "The first reply in a conversation comes sooner. TRH AI has its model read its standing instructions ahead of time, so the model is loaded a little earlier than before: when TRH AI starts, and when you click into the chat box. It helps most on a PC without a graphics card.",
      "The microphone says so when nothing is installed to turn speech into text, instead of recording and dropping what you said.",
      "Telling TRH AI to forget something now also removes it from the conversation the AI reads, so it is no longer repeated back to you from earlier messages.",
      "Asking for code in a reply (a function, a one-liner, a script) gets you the code; TRH AI no longer tries to run it as a command.",
      "Screens now say plainly what leaves your PC (web lookups, update checks, and downloads of models and tools), and Files offers to summarise only PDF, Word (.docx) and PowerPoint (.pptx) files.",
      "Behind the scenes, TRH AI's local service moved to Express 5."
    ]
  },
  {
    version: "0.1.5",
    date: "2026-10-16",
    title: "Trial, license keys, self-updating and a safer app",
    notes: [
      "Sums, today's date and the time are answered at once, without waiting for the AI model.",
      "Security: TRH AI now runs on Electron 44 with its window sandboxed. Its local services answer only this PC, and its AI engine only TRH AI.",
      "A trial record changed by hand ends the trial, and reinstalling no longer starts a new one.",
      "TRH AI now starts a 14-day free trial on a new PC. After that it asks for a license key; everything it holds stays readable, and a key unlocks it again.",
      "Settings has a Plan and billing section: where to buy, your plan, your key.",
      "A What's new notice like this one appears the first time a new version runs, and TRH AI tells you when a newer version is out. The installed app downloads it, installs it when you say so and opens again by itself.",
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

/**
 * The text of the GitHub release page for `version`, made from its note.
 *
 * An installed copy shows this text as it stands when it offers the update
 * (apps/api/src/services/updates.ts keeps the first 4,000 characters), so it
 * is plain sentences for the people using the app: no list of pull requests,
 * and no markdown that would show as symbols. Null when the version has no
 * note, which the Release workflow refuses to publish without.
 */
export function releasePageText(version: string, options: { candidate?: boolean } = {}, notes: ReleaseNote[] = releaseNotes): string | null {
  const note = notes.find((entry) => entry.version === version);
  if (!note) return null;
  return [
    note.title,
    "",
    ...note.notes.map((line) => `- ${line}`),
    "",
    ...(options.candidate ? ["This is a release candidate, published for testing. Installed copies of TRH AI are not offered it.", ""] : []),
    `Windows only. TRH-AI-Setup-${version}.exe installs it; TRH-AI-Portable-${version}.exe runs without installing. SHA256SUMS.txt lists each file's SHA-256 checksum.`,
    // Until the installer is signed (docs/23-install-story.md).
    "The installer is not code-signed yet, so Windows SmartScreen may warn the first time it runs."
  ].join("\n");
}
