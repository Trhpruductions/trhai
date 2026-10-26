// The tools beside the model: a voice to speak with, ears to listen with, and
// ffmpeg to make videos with. First-run setup (modelSetup.ts) installs them the
// same way it installs the engine and the models.
//
// Until this, each was a manual install: unzip Piper into a folder in the home
// directory and download a voice by hand, do the same for whisper.cpp and a
// model, and run winget for ffmpeg. An installed copy of the app, and the
// person using it, could not be expected to do any of that, so the voice,
// listening and video screens sat there saying they were not installed.
//
// - Everything comes from the people who made it: Piper's and whisper.cpp's own
//   GitHub releases, the voice and the model from Hugging Face, ffmpeg from the
//   release page of the Windows builds `winget install Gyan.FFmpeg` also uses.
// - Every file is pinned: a release tag or a repository commit, its exact size
//   and its SHA-256. One that does not match is thrown away, never installed.
// - A tool puts itself where the app already looks for it (piperSpeech.ts and
//   whisperTranscribe.ts), so a copy a person installed by hand keeps working,
//   and a tool that is already there is left alone.
//
// The voices are Alan, Amy, Cori, Ryan and Jarvis: what the app's owner has on
// their own PC, so that everyone else hears the same ones. They do not share a
// licence. Cori, recorded from public-domain LibriVox readings, is the only one
// plainly free to use in anything. Ryan is CC BY-NC-SA (non-commercial), Alan's
// licence file says "All Rights Reserved", Amy's makers state none, and Jarvis
// is a fan-made imitation of a film character's voice. Each is labelled with
// what is known of it, below and on the screen that installs it, so that none
// is passed off as free; dropping one is deleting its entry from `piperVoices`.
// More voices can be added by putting their two files beside Piper's.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { PinnedFile } from "./modelSetup.js";
import { ffmpegAvailable, ffmpegHome, ffmpegRunsPatiently, forgetFfmpegCheck } from "./ffmpegPath.js";
import { piperRoot, piperStatus } from "./piperSpeech.js";
import { binaryPath as whisperProgram, installedModels, whisperRoot, whisperStatus } from "./whisperTranscribe.js";

export type ToolId = "speech" | "listening" | "video";

export type ToolLicense = { name: string; url: string; commercialUse: boolean };

/** Something a tool installs that has a licence of its own: one of the voices. */
export type IncludedPart = { label: string; license: ToolLicense };

export type ToolDef = {
  id: ToolId;
  label: string;
  /** One sentence: what it gives a person, in their words. */
  summary: string;
  /** What using it needs besides the tool. */
  needs: string;
  license: ToolLicense;
  /** What it installs that is not under `license`: each part with the licence it came with. */
  included?: IncludedPart[];
  /** Everything it downloads when none of it is here yet. */
  files: PinnedFile[];
  /** The files still to fetch: all of them, or only the part that is missing. Empty when it is all there. */
  missing(env: NodeJS.ProcessEnv): PinnedFile[];
  /** Whether the app can use it now. */
  installed(env: NodeJS.ProcessEnv): boolean;
  /**
   * After the files are put in place: whether the app can use it, asked with
   * patience and without holding up the service. A program written a moment ago
   * may be held by antivirus while it is looked at. When absent, `installed` is the answer.
   */
  usable?(env: NodeJS.ProcessEnv): Promise<boolean>;
  /** Puts what was downloaded (in `downloads`, by file name) where the app looks for it, unpacking archives with `unpack`. */
  place(downloads: string, env: NodeJS.ProcessEnv, unpack: (archive: string, into: string) => void): void;
};

const windows = process.platform === "win32";

const github = (repo: string, tag: string, name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name, sizeBytes, sha256, url: `https://github.com/${repo}/releases/download/${tag}/${name}`
});

/** `saveAs` is the name the file is kept under, for one whose makers named it something the app cannot use. */
const huggingFace = (repo: string, commit: string, folder: string, name: string, sizeBytes: number, sha256: string, saveAs = name): PinnedFile => ({
  name: saveAs, sizeBytes, sha256, url: `https://huggingface.co/${repo}/resolve/${commit}/${folder}${name}`
});

// ---------------------------------------------------------------- what is on disk

/** The folder under `root`, at most three levels down, that holds `relative`; null when none does. */
function folderHolding(root: string, relative: string, depth = 3): string | null {
  if (existsSync(path.join(root, relative))) return root;
  if (depth === 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const child = path.join(root, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = folderHolding(child, relative, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Copies everything in `from` into `to`, over what is there. */
function copyInto(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
}

/** Moves a file, copying it first when the two places are on different drives. */
function moveFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  rmSync(to, { force: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to);
    rmSync(from, { force: true });
  }
}

/** Unpacks into a clean folder beside the downloads and returns it. */
function unpackedBeside(downloads: string, name: string, archive: string, unpack: (archive: string, into: string) => void): string {
  const staging = path.join(downloads, name);
  rmSync(staging, { recursive: true, force: true });
  unpack(archive, staging);
  return staging;
}

// ---------------------------------------------------------------- speech: Piper and its voices

const piperVoiceCommit = "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd";
/** The Jarvis voice is not in Piper's collection: it is its maker's own repository, pinned the same way. */
const jarvisVoiceCommit = "37f8763122312665f091d1fc760abaf1f79b02cc";

export const piperArchive = github(
  "rhasspy/piper", "2023.11.14-2", "piper_windows_amd64.zip", 22_477_236,
  "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea"
);

/** One voice as Piper wants it. */
export type PiperVoiceDef = {
  /** The id the app and the picker use: the model's file stem, `locale-speaker-quality`, which is how Piper names them. */
  id: string;
  label: string;
  license: ToolLicense;
  /** The model and the json beside it: Piper cannot load one without the other. */
  files: PinnedFile[];
};

/**
 * A voice's two files, kept under the app's id for it. `published` is what the
 * makers called them when that is not the same: the app reads a voice's speaker
 * and quality from its file name, and the Jarvis files are called `jarvis-high`.
 */
function voiceFiles(
  repo: string, commit: string, folder: string, id: string, published: string,
  model: [sizeBytes: number, sha256: string], config: [sizeBytes: number, sha256: string]
): PinnedFile[] {
  return [
    huggingFace(repo, commit, folder, `${published}.onnx`, model[0], model[1], `${id}.onnx`),
    huggingFace(repo, commit, folder, `${published}.onnx.json`, config[0], config[1], `${id}.onnx.json`)
  ];
}

const piperVoicesRepo = "rhasspy/piper-voices";

/**
 * Every voice the voice tool installs, the app's own default first. What is
 * written in `license` is what each voice's makers say and no more; `commercialUse`
 * is true only where they say it outright.
 */
export const piperVoices: PiperVoiceDef[] = [
  {
    id: "en_GB-alan-medium", label: "Alan",
    license: { name: "All rights reserved (Mycroft AI)", url: "https://github.com/MycroftAI/mimic3-voices/blob/master/voices/en_UK/apope_low/LICENSE", commercialUse: false },
    files: voiceFiles(piperVoicesRepo, piperVoiceCommit, "en/en_GB/alan/medium/", "en_GB-alan-medium", "en_GB-alan-medium",
      [63_201_294, "0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330"],
      [4_888, "c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e"])
  },
  {
    id: "en_GB-cori-high", label: "Cori",
    license: { name: "Public domain (LibriVox recordings)", url: "https://librivox.org/pages/public-domain/", commercialUse: true },
    files: voiceFiles(piperVoicesRepo, piperVoiceCommit, "en/en_GB/cori/high/", "en_GB-cori-high", "en_GB-cori-high",
      [114_219_352, "470b4dd634c98f8a4850d7626ffc3dfc90774628eeef6605a6dd8f88f30a5903"],
      [4_963, "9e7fb5b5671612c22f3c81cbe46c1ae87b031a4632bcb509e499dad6f1e2adec"])
  },
  {
    id: "en_GB-jarvis-high", label: "Jarvis",
    license: { name: "Fan-made imitation of a film character (tagged MIT, not cleared)", url: "https://huggingface.co/jgkawell/jarvis", commercialUse: false },
    files: voiceFiles("jgkawell/jarvis", jarvisVoiceCommit, "en/en_GB/jarvis/high/", "en_GB-jarvis-high", "jarvis-high",
      [114_199_011, "9791877d9c099fabbf30be2825e011451c39b3431e21e81e866f5b6507e72993"],
      [7_262, "d0b8772d81c1da2fcdfd79e90bff027f46f040450e1deb89b43a9f6b1946c5a7"])
  },
  {
    id: "en_US-ryan-high", label: "Ryan",
    license: { name: "CC BY-NC-SA 4.0 (non-commercial)", url: "https://creativecommons.org/licenses/by-nc-sa/4.0/", commercialUse: false },
    files: voiceFiles(piperVoicesRepo, piperVoiceCommit, "en/en_US/ryan/high/", "en_US-ryan-high", "en_US-ryan-high",
      [120_786_792, "b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca"],
      [4_166, "c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011"])
  },
  {
    id: "en_US-amy-medium", label: "Amy",
    license: { name: "No licence stated (Mimic 3 collection)", url: "https://github.com/MycroftAI/mimic3-voices", commercialUse: false },
    files: voiceFiles(piperVoicesRepo, piperVoiceCommit, "en/en_US/amy/medium/", "en_US-amy-medium", "en_US-amy-medium",
      [63_201_294, "b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18"],
      [4_882, "95a23eb4d42909d38df73bb9ac7f45f597dbfcde2d1bf9526fdeaf5466977d77"])
  }
];

/** Every voice file, two to a voice. */
export const piperVoiceFiles: PinnedFile[] = piperVoices.flatMap((voice) => voice.files);

const piperProgram = windows ? "piper.exe" : "piper";

const speech: ToolDef = {
  id: "speech",
  label: "Voice (Piper)",
  summary: "Lets TRH AI read its answers aloud in a natural voice, with five to choose from: Alan, Amy, Cori, Ryan and Jarvis. Installs Piper and all five.",
  needs: "speakers or headphones",
  license: { name: "Piper is MIT; each voice has a licence of its own, listed below", url: "https://github.com/rhasspy/piper/blob/master/LICENSE.md", commercialUse: false },
  included: piperVoices.map(({ label, license }) => ({ label, license })),
  files: [piperArchive, ...piperVoiceFiles],
  // Every voice that is not there yet, whether or not Piper can speak with one already: a copy
  // that had only Cori is brought up to all five, and a voice a person put there themselves stays.
  missing: () => [
    ...(existsSync(path.join(piperRoot(), piperProgram)) ? [] : [piperArchive]),
    ...piperVoiceFiles.filter((file) => !existsSync(path.join(piperRoot(), file.name)))
  ],
  installed: () => piperStatus().available,
  place(downloads, _env, unpack) {
    const root = piperRoot();
    const archive = path.join(downloads, piperArchive.name);
    if (existsSync(archive)) {
      const staging = unpackedBeside(downloads, "piper-unpacked", archive, unpack);
      const folder = folderHolding(staging, piperProgram);
      if (!folder) throw new Error(`Piper unpacked, but there is no ${piperProgram} in it.`);
      copyInto(folder, root);
      rmSync(staging, { recursive: true, force: true });
    }
    for (const file of piperVoiceFiles) {
      const from = path.join(downloads, file.name);
      if (existsSync(from)) moveFile(from, path.join(root, file.name));
    }
  }
};

// ---------------------------------------------------------------- listening: whisper.cpp and a model

export const whisperArchive = github(
  "ggml-org/whisper.cpp", "b4938", "whisper-bin-x64.zip", 8_361_840,
  "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d"
);

export const whisperModel = huggingFace(
  "ggerganov/whisper.cpp", "5359861c739e955e79d9a303bcbc70fb988958b1", "", "ggml-base.en.bin", 147_964_211,
  "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
);

const listening: ToolDef = {
  id: "listening",
  label: "Listening (Whisper)",
  summary: "Lets you talk to TRH AI. What you say is turned into text on this PC and never sent anywhere. Installs whisper.cpp and its English base model.",
  needs: "a microphone",
  license: { name: "whisper.cpp and the Whisper model are MIT", url: "https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE", commercialUse: true },
  files: [whisperArchive, whisperModel],
  missing: () => [
    ...(whisperProgram() ? [] : [whisperArchive]),
    ...(installedModels().length > 0 ? [] : [whisperModel])
  ],
  installed: () => whisperStatus().available,
  place(downloads, _env, unpack) {
    const root = whisperRoot();
    const archive = path.join(downloads, whisperArchive.name);
    if (existsSync(archive)) {
      const staging = unpackedBeside(downloads, "whisper-unpacked", archive, unpack);
      const program = windows ? "whisper-cli.exe" : "whisper-cli";
      if (!folderHolding(staging, program)) throw new Error(`whisper.cpp unpacked, but there is no ${program} in it.`);
      // Kept as the zip lays it out (a Release folder), which is one of the places the app looks.
      copyInto(staging, root);
      rmSync(staging, { recursive: true, force: true });
    }
    const model = path.join(downloads, whisperModel.name);
    if (existsSync(model)) moveFile(model, path.join(root, whisperModel.name));
  }
};

// ---------------------------------------------------------------- video: ffmpeg

/** The "essentials" Windows build: everything the video maker uses (x264, AAC), without the extras. */
export const ffmpegArchive = github(
  "GyanD/codexffmpeg", "9.0.2", "ffmpeg-9.0.2-essentials_build.zip", 114_768_076,
  "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
);

const ffmpegExe = path.join("bin", windows ? "ffmpeg.exe" : "ffmpeg");

const video: ToolDef = {
  id: "video",
  label: "Video (ffmpeg)",
  summary: "Lets TRH AI make short narrated videos on this PC. Installs ffmpeg for TRH AI's own use; nothing else on the PC changes.",
  needs: "the voice, for narration",
  license: { name: "ffmpeg, in the GPL 3 Windows build from gyan.dev", url: "https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2", commercialUse: true },
  files: [ffmpegArchive],
  missing: (env) => (ffmpegAvailable(env) ? [] : [ffmpegArchive]),
  installed: (env) => ffmpegAvailable(env),
  usable: (env) => ffmpegRunsPatiently(env),
  place(downloads, env, unpack) {
    const staging = unpackedBeside(downloads, "ffmpeg-unpacked", path.join(downloads, ffmpegArchive.name), unpack);
    const folder = folderHolding(staging, ffmpegExe);
    if (!folder) throw new Error(`ffmpeg unpacked, but there is no ${ffmpegExe} in it.`);
    // Only ffmpeg itself, and its licence: the video maker needs nothing else of the build.
    const home = ffmpegHome(env);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(path.join(home, "bin"), { recursive: true });
    cpSync(path.join(folder, ffmpegExe), path.join(home, ffmpegExe));
    for (const name of ["LICENSE", "README.txt"]) {
      if (existsSync(path.join(folder, name))) cpSync(path.join(folder, name), path.join(home, name));
    }
    rmSync(staging, { recursive: true, force: true });
    forgetFfmpegCheck();
  }
};

export const toolCatalogue: ToolDef[] = [speech, listening, video];

export function catalogueTool(id: string, tools: ToolDef[] = toolCatalogue): ToolDef | undefined {
  return tools.find((tool) => tool.id === id);
}

/** What the screens show for each tool. */
export type ToolStatus = {
  id: ToolId;
  label: string;
  summary: string;
  needs: string;
  license: ToolLicense;
  /** The parts with a licence of their own (the voices); empty for a tool that is one thing. */
  included: IncludedPart[];
  installed: boolean;
  /** Bytes still to download: all of them, part of them, or none when it is installed. */
  sizeBytes: number;
  /**
   * Bytes of the tool's own files that are not here yet, whether or not it works:
   * a copy that could speak in one voice and is short of four others still works,
   * and this is what is left to fetch.
   */
  missingBytes: number;
  /** False on a PC the tool is not built for. */
  supported: boolean;
};

export function toolStatuses(env: NodeJS.ProcessEnv = process.env, tools: ToolDef[] = toolCatalogue): ToolStatus[] {
  return tools.map((tool) => {
    const installed = tool.installed(env);
    const missingBytes = tool.missing(env).reduce((sum, file) => sum + file.sizeBytes, 0);
    return {
      id: tool.id,
      label: tool.label,
      summary: tool.summary,
      needs: tool.needs,
      license: tool.license,
      included: tool.included ?? [],
      installed,
      sizeBytes: installed ? 0 : missingBytes,
      missingBytes,
      // Read now rather than at load, so that a test can stand in for another PC.
      supported: process.platform === "win32"
    };
  });
}
