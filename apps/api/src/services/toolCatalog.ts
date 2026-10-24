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
// The voice is Cori, an English (British) voice recorded from public-domain
// LibriVox readings. It is the default because its licence allows what the rest
// of the app allows; the most popular Piper voice, Ryan, is CC BY-NC-SA and is
// not offered for that reason. More voices can be added by putting their two
// files beside Piper's.

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { PinnedFile } from "./modelSetup.js";
import { ffmpegAvailable, ffmpegHome, forgetFfmpegCheck } from "./ffmpegPath.js";
import { installedVoices, piperRoot, piperStatus } from "./piperSpeech.js";
import { binaryPath as whisperProgram, installedModels, whisperRoot, whisperStatus } from "./whisperTranscribe.js";

export type ToolId = "speech" | "listening" | "video";

export type ToolLicense = { name: string; url: string; commercialUse: boolean };

export type ToolDef = {
  id: ToolId;
  label: string;
  /** One sentence: what it gives a person, in their words. */
  summary: string;
  /** What using it needs besides the tool. */
  needs: string;
  license: ToolLicense;
  /** Everything it downloads when none of it is here yet. */
  files: PinnedFile[];
  /** The files still to fetch: all of them, or only the part that is missing. Empty when it is all there. */
  missing(env: NodeJS.ProcessEnv): PinnedFile[];
  /** Whether the app can use it now. */
  installed(env: NodeJS.ProcessEnv): boolean;
  /** Puts what was downloaded (in `downloads`, by file name) where the app looks for it, unpacking archives with `unpack`. */
  place(downloads: string, env: NodeJS.ProcessEnv, unpack: (archive: string, into: string) => void): void;
};

const windows = process.platform === "win32";

const github = (repo: string, tag: string, name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name, sizeBytes, sha256, url: `https://github.com/${repo}/releases/download/${tag}/${name}`
});

const huggingFace = (repo: string, commit: string, folder: string, name: string, sizeBytes: number, sha256: string): PinnedFile => ({
  name, sizeBytes, sha256, url: `https://huggingface.co/${repo}/resolve/${commit}/${folder}${name}`
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

// ---------------------------------------------------------------- speech: Piper and a voice

const piperVoiceCommit = "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd";

export const piperArchive = github(
  "rhasspy/piper", "2023.11.14-2", "piper_windows_amd64.zip", 22_477_236,
  "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea"
);

/** A voice is two files, and Piper cannot load one without the other. */
export const piperVoiceFiles: PinnedFile[] = [
  huggingFace("rhasspy/piper-voices", piperVoiceCommit, "en/en_GB/cori/high/", "en_GB-cori-high.onnx", 114_219_352,
    "470b4dd634c98f8a4850d7626ffc3dfc90774628eeef6605a6dd8f88f30a5903"),
  huggingFace("rhasspy/piper-voices", piperVoiceCommit, "en/en_GB/cori/high/", "en_GB-cori-high.onnx.json", 4_963,
    "9e7fb5b5671612c22f3c81cbe46c1ae87b031a4632bcb509e499dad6f1e2adec")
];

const piperProgram = windows ? "piper.exe" : "piper";

const speech: ToolDef = {
  id: "speech",
  label: "Voice (Piper)",
  summary: "Lets TRH AI read its answers aloud in a natural voice. Installs Piper and the Cori voice, in British English.",
  needs: "speakers or headphones",
  license: { name: "Piper is MIT; the Cori voice is public domain", url: "https://github.com/rhasspy/piper/blob/master/LICENSE.md", commercialUse: true },
  files: [piperArchive, ...piperVoiceFiles],
  missing: () => [
    ...(existsSync(path.join(piperRoot(), piperProgram)) ? [] : [piperArchive]),
    ...(installedVoices().length > 0 ? [] : piperVoiceFiles)
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
  installed: boolean;
  /** Bytes still to download: all of them, part of them, or none when it is installed. */
  sizeBytes: number;
  /** False on a PC the tool is not built for. */
  supported: boolean;
};

export function toolStatuses(env: NodeJS.ProcessEnv = process.env, tools: ToolDef[] = toolCatalogue): ToolStatus[] {
  return tools.map((tool) => {
    const installed = tool.installed(env);
    return {
      id: tool.id,
      label: tool.label,
      summary: tool.summary,
      needs: tool.needs,
      license: tool.license,
      installed,
      sizeBytes: installed ? 0 : tool.missing(env).reduce((sum, file) => sum + file.sizeBytes, 0),
      // Read now rather than at load, so that a test can stand in for another PC.
      supported: process.platform === "win32"
    };
  });
}
