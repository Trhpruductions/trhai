import { execFile } from "node:child_process";
import { toolDefinitions } from "./agentTools.js";
import { armedUntil, commandsArmed } from "./commandRunner.js";
import { readEmailAccount } from "./emailAccount.js";
import { checkAvailability, readLocalModelConfig } from "./localModel.js";
import { phoneLinkStatus } from "./messaging.js";
import { piperStatus } from "./piperSpeech.js";
import { permissionLabels, permissionLevelOf, requiresConfirmation, type PermissionLevel } from "./toolPermissions.js";
import { toolUsage, type ToolUsage } from "./toolUsage.js";
import { findVisionModel, visionModelName } from "./vision.js";

// Every tool TRH AI has, described for the person using it: what it does in
// plain words, how much it is allowed to do, whether it can run on this PC
// right now and why not, and how often it has run.
//
// The descriptions the model is given are instructions to the model ("Use
// this before answering..."), so they are not what a person should read; the
// catalogue below is. A test holds it to the registry, so a tool cannot be
// added without saying what it is for.
//
// Readiness is only ever a check that was made: the machine-access switch, an
// installed program, a linked phone. A tool with no prerequisite of its own is
// ready; whether the model itself is answering is reported once, for all of
// them, rather than repeated on every tool.

export type ToolArea =
  | "Memory" | "Documents" | "Files" | "Apps" | "Web" | "Schedules" | "Time and maths" | "Media" | "Messages" | "This PC";

export type ToolReadiness = {
  state: "ready" | "off" | "needs-setup";
  /** Why, or what it depends on, in the user's words. */
  note: string | null;
};

export type ToolEntry = {
  name: string;
  title: string;
  summary: string;
  area: ToolArea;
  /** What the model is told about the tool, word for word. */
  instructions: string;
  level: PermissionLevel;
  levelLabel: string;
  /** Held for the user's yes before it runs. */
  asksFirst: boolean;
  readiness: ToolReadiness;
  usage: ToolUsage;
};

type CatalogueEntry = { title: string; summary: string; area: ToolArea };

export const toolCatalogue: Record<string, CatalogueEntry> = {
  search_memory: { area: "Memory", title: "Search memory", summary: "Looks through what you have asked TRH AI to remember." },
  list_memories: { area: "Memory", title: "List memories", summary: "Lists everything TRH AI remembers about you." },
  remember: { area: "Memory", title: "Remember", summary: "Saves something you said, so it is there in later conversations." },
  pin_memory: { area: "Memory", title: "Pin a memory", summary: "Marks a memory as important, so it is used first." },
  forget: { area: "Memory", title: "Forget", summary: "Deletes a memory you no longer want kept." },
  search_conversation: { area: "Memory", title: "Search the conversation", summary: "Finds something said earlier in a conversation that was never saved to memory." },
  search_documents: { area: "Documents", title: "Search documents", summary: "Searches the documents in your knowledge base." },
  list_documents: { area: "Documents", title: "List documents", summary: "Lists the title of every document in your knowledge base." },
  read_document: { area: "Documents", title: "Read a document", summary: "Reads a whole document from your knowledge base." },
  summarize_document: { area: "Documents", title: "Summarise a document", summary: "Summarises a document of any length, from your knowledge base or a PDF, Word, PowerPoint or text file on this PC." },
  write_document: { area: "Documents", title: "Write a document", summary: "Saves notes or a draft as a new document in your knowledge base." },
  update_document: { area: "Documents", title: "Update a document", summary: "Adds to or changes a document already in your knowledge base." },
  delete_document: { area: "Documents", title: "Delete a document", summary: "Deletes a document from your knowledge base." },
  list_files: { area: "Files", title: "List files", summary: "Lists what is in a folder." },
  search_files: { area: "Files", title: "Search files", summary: "Finds which files contain some text, with the lines that match." },
  read_file: { area: "Files", title: "Read a file", summary: "Opens a file to read it." },
  write_file: { area: "Files", title: "Write a file", summary: "Creates or replaces a file, making folders as needed." },
  edit_file: { area: "Files", title: "Edit a file", summary: "Changes part of a file and leaves the rest as it was." },
  plan_app: { area: "Apps", title: "Plan an app", summary: "Sketches what an app would hold - its records, fields and screens - without building it." },
  build_app: { area: "Apps", title: "Build an app", summary: "Builds a small working app from a description, starts it and runs its own tests." },
  change_app: { area: "Apps", title: "Change an app", summary: "Adds or removes a field or a feature in an app TRH AI built." },
  run_app: { area: "Apps", title: "Run an app", summary: "Starts an app TRH AI built and gives you its address." },
  stop_app: { area: "Apps", title: "Stop an app", summary: "Stops an app that is running." },
  web_search: { area: "Web", title: "Search the web", summary: "Searches the web and brings back real result pages." },
  fetch_url: { area: "Web", title: "Read a web page", summary: "Reads the text of a web page." },
  list_schedules: { area: "Schedules", title: "List schedules", summary: "Lists what is scheduled, how often it runs and whether it is on." },
  add_schedule: { area: "Schedules", title: "Add a schedule", summary: "Sets up a question or a reminder to run every day, or every so many minutes." },
  calculate: { area: "Time and maths", title: "Calculate", summary: "Works out arithmetic exactly, rather than guessing." },
  current_datetime: { area: "Time and maths", title: "Date and time", summary: "Reads today's date and the time on this PC." },
  days_between: { area: "Time and maths", title: "Days between", summary: "Counts the days between two dates." },
  shift_date: { area: "Time and maths", title: "Move a date", summary: "Finds the date a number of days before or after another." },
  shift_time: { area: "Time and maths", title: "Move a time", summary: "Finds the clock time some hours and minutes before or after another." },
  look_at_image: { area: "Media", title: "Look at an image", summary: "Looks at a screenshot, photo or scan on this PC, and reads any text in it." },
  render_mockup: { area: "Media", title: "Show a mockup", summary: "Draws a screen mockup or a diagram you can see straight away." },
  make_video: { area: "Media", title: "Make a video", summary: "Makes a short narrated motion-graphics video, rendered on this PC." },
  send_text: { area: "Messages", title: "Send a text", summary: "Sends a text from your own phone, through Phone Link." },
  send_email: { area: "Messages", title: "Send an email", summary: "Sends an email from your own account, or opens it in your mail app." },
  system_status: { area: "This PC", title: "Read this PC", summary: "Reads live processor, memory, graphics card, disk and network figures." },
  run_command: { area: "This PC", title: "Run a command", summary: "Runs a command on this PC and brings back its real output." }
};

/** The checks readiness is decided from, made once per request. */
export type ToolProbe = {
  machineAccess: { armed: boolean; until: string | null };
  model: { available: boolean; name: string | null; reason: string | null };
  /** The vision model installed, if any. */
  visionModel: string | null;
  ffmpeg: boolean;
  piper: boolean;
  phoneLink: "linked" | "not-linked" | "missing";
  /** The address an email account is set up with, if one is. */
  emailAccount: string | null;
};

const fileTools = new Set(["list_files", "search_files", "read_file", "write_file", "edit_file"]);

function readinessOf(name: string, probe: ToolProbe): ToolReadiness {
  const ready = (note: string | null = null): ToolReadiness => ({ state: "ready", note });
  if (name === "run_command") {
    return probe.machineAccess.armed
      ? ready("Machine access is on, which is the permission: commands run without asking while it lasts.")
      : { state: "off", note: "Machine access is off. Switch it on below to let TRH AI run commands." };
  }
  if (fileTools.has(name)) {
    return ready(probe.machineAccess.armed
      ? "Reaches anywhere on this PC while machine access is on."
      : "Works in the workspace. Machine access lets it reach the rest of this PC.");
  }
  if (name === "look_at_image") {
    return probe.visionModel
      ? ready(`Uses ${probe.visionModel}, on this PC.`)
      : { state: "needs-setup", note: `Needs a vision model in Ollama, such as ${visionModelName()}.` };
  }
  if (name === "make_video") {
    if (!probe.ffmpeg) return { state: "needs-setup", note: "Needs ffmpeg installed - it encodes the video." };
    if (!probe.piper) return { state: "needs-setup", note: "Needs a Piper voice installed - it narrates the video." };
    return ready("Narrated with Piper and encoded with ffmpeg, on this PC.");
  }
  if (name === "send_text") {
    return probe.phoneLink === "linked"
      ? ready("Opens in Phone Link, to send from your phone.")
      : { state: "needs-setup", note: probe.phoneLink === "not-linked" ? "Link your phone in Phone Link to send texts." : "Needs Phone Link, from the Microsoft Store." };
  }
  if (name === "send_email") {
    return ready(probe.emailAccount
      ? `Sends from ${probe.emailAccount}.`
      : "Opens your mail app. Add your account in Settings to send directly.");
  }
  if (name === "web_search" || name === "fetch_url") return ready("Needs the internet.");
  return ready();
}

/** Every registered tool, described; in the catalogue's order. */
export function describeTools(probe: ToolProbe): ToolEntry[] {
  const order = Object.keys(toolCatalogue);
  return toolDefinitions
    .map((definition): ToolEntry => {
      const name = definition.function.name;
      const entry = toolCatalogue[name] ?? { area: "This PC" as const, title: name.replace(/_/g, " "), summary: definition.function.description };
      const level = permissionLevelOf(name);
      return {
        name,
        title: entry.title,
        summary: entry.summary,
        area: entry.area,
        instructions: definition.function.description,
        level,
        levelLabel: permissionLabels[level],
        // Machine access is run_command's permission; it never asks per command.
        asksFirst: requiresConfirmation(name) && name !== "run_command",
        readiness: readinessOf(name, probe),
        usage: toolUsage(name)
      };
    })
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

let ffmpegCache: { present: boolean; checkedAt: number } | null = null;
const ffmpegCacheMs = 5 * 60_000;

/** Whether ffmpeg runs, checked the way the video renderer starts it; cached for five minutes. */
function ffmpegPresent(): Promise<boolean> {
  if (ffmpegCache && Date.now() - ffmpegCache.checkedAt < ffmpegCacheMs) return Promise.resolve(ffmpegCache.present);
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { windowsHide: true, timeout: 5000 }, (error) => {
      ffmpegCache = { present: !error, checkedAt: Date.now() };
      resolve(!error);
    });
  });
}

/** The real checks, for the route. */
export async function probeTools(): Promise<ToolProbe> {
  const config = readLocalModelConfig();
  const [availability, vision, ffmpeg] = await Promise.all([
    checkAvailability(config),
    findVisionModel(config.baseUrl, visionModelName()),
    ffmpegPresent()
  ]);
  return {
    machineAccess: { armed: commandsArmed(), until: armedUntil() },
    model: {
      available: availability.available,
      name: availability.available ? availability.model : null,
      reason: availability.available ? null : availability.reason
    },
    visionModel: vision.model,
    ffmpeg,
    piper: piperStatus().available,
    phoneLink: phoneLinkStatus(),
    emailAccount: readEmailAccount()?.address ?? null
  };
}
