import type { CoreState } from "../../components/Core";

// What the core's state is called on screen. The brief's vocabulary - standing
// by, listening, thinking, processing, executing, responding, complete - mapped
// from the states corePresence derives from real activity. Several tool
// states (searching, reading, writing, analysing) are all "processing" to a
// person; the tool's own name is shown alongside where it matters.

export type CoreTone = "idle" | "listen" | "think" | "work" | "speak" | "ok" | "danger" | "off";

export function coreWords(state: CoreState): { word: string; tone: CoreTone } {
  switch (state) {
    case "listening": return { word: "Listening", tone: "listen" };
    case "thinking": return { word: "Thinking", tone: "think" };
    case "searching":
    case "reading":
    case "writing":
    case "analysing": return { word: "Processing", tone: "work" };
    case "executing": return { word: "Executing", tone: "work" };
    case "speaking": return { word: "Responding", tone: "speak" };
    case "success": return { word: "Complete", tone: "ok" };
    case "error": return { word: "Error", tone: "danger" };
    case "offline": return { word: "Offline", tone: "off" };
    default: return { word: "Standing by", tone: "idle" };
  }
}
