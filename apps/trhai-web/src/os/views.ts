// Every workspace in TRH AI, in one list.
//
// The sidebar, the command palette, the keyboard shortcuts and the address
// (#chat, #memory...) all read from here, so a workspace exists in all four
// places or in none - never a nav item that opens nothing, or a shortcut to a
// screen the sidebar does not list.

export type ViewId =
  | "home" | "chat" | "voice"
  | "memory" | "files" | "browser"
  | "code" | "tasks" | "automation" | "tools"
  | "system" | "network" | "settings";

export type ViewGroup = "Command" | "Knowledge" | "Work" | "System";

export type ViewDef = {
  id: ViewId;
  label: string;
  /** One line under the title, saying what the workspace is for. */
  blurb: string;
  group: ViewGroup;
  /** SVG path data on a 24px box, stroked. */
  icon: string;
  /** Words the command palette also matches. */
  keywords: string;
};

export const views: ViewDef[] = [
  {
    id: "home", label: "Home", group: "Command", blurb: "Command center - the core, live activity and what needs you.",
    icon: "M3 10.5 12 3l9 7.5M5 9.5V20h5v-6h4v6h5V9.5", keywords: "dashboard core command center start"
  },
  {
    id: "chat", label: "AI Chat", group: "Command", blurb: "Talk to TRH AI - every reply is written on this PC.",
    icon: "M4 5.5h16v10H9l-5 4v-14ZM8 9.5h8M8 12.5h5", keywords: "conversation ask message talk assistant"
  },
  {
    id: "voice", label: "Voice", group: "Command", blurb: "Speak to TRH AI and hear it answer - transcribed and spoken locally.",
    icon: "M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3ZM6 11a6 6 0 0 0 12 0M12 17v3.5", keywords: "microphone speak listen talk hands-free"
  },
  {
    id: "memory", label: "Memory", group: "Knowledge", blurb: "What TRH AI knows about you, and the documents it can read.",
    icon: "M5 6h14v12H5zM9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M9 10h6M9 13h6", keywords: "remember facts documents knowledge notes"
  },
  {
    id: "files", label: "Files", group: "Knowledge", blurb: "TRH AI's workspace on this PC - browse it, search it, preview anything in it.",
    icon: "M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z", keywords: "workspace folder documents browse search preview images video"
  },
  {
    id: "browser", label: "Browser", group: "Knowledge", blurb: "Search the web and read pages as text, without leaving TRH AI.",
    icon: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17ZM3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5Z",
    keywords: "web internet search read page url link website duckduckgo"
  },
  {
    id: "code", label: "Code", group: "Work", blurb: "The apps TRH AI has built - run them, see them live, read their code - and every command it has run.",
    icon: "M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13", keywords: "apps projects build run preview terminal commands code"
  },
  {
    id: "tasks", label: "Tasks", group: "Work", blurb: "What TRH AI is working on, what runs on a schedule, everything it has finished - and your to-dos.",
    icon: "M4 7h4M4 12h4M4 17h4M12 6l2 2 4-4M12 12h7M12 17h7", keywords: "todo work jobs queue history schedule reminders running failed"
  },
  {
    id: "automation", label: "Automation", group: "Work", blurb: "A flow of checks, conditions and waits - dry-run it, run it, put it on a schedule.",
    icon: "M5 4.5h5v5H5zM14 14.5h5v5h-5zM7.5 9.5v3a2 2 0 0 0 2 2H14M16.5 4.5v7", keywords: "flow automate workflow steps if wait script check schedule"
  },
  {
    id: "tools", label: "Tools", group: "Work", blurb: "Everything TRH AI can do, and how much each is allowed.",
    icon: "M14.5 6a3.5 3.5 0 0 0-4.9 4.2l-6 6L6 18.5l6-6A3.5 3.5 0 0 0 18 8l-2.3 2.3-1.7-1.7L16.3 6.3A3.5 3.5 0 0 0 14.5 6Z", keywords: "capabilities permissions commands machine access status usage ready"
  },
  {
    id: "system", label: "System", group: "System", blurb: "This machine, measured live. Anything that cannot be read says so.",
    icon: "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4ZM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8", keywords: "cpu ram gpu disk monitor performance health"
  },
  {
    id: "network", label: "Network", group: "System", blurb: "Connections, throughput and the local services TRH AI runs on.",
    icon: "M12 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM5 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM19 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 7v4M12 11l-6 5M12 11l6 5", keywords: "internet connection api services throughput"
  },
  {
    id: "settings", label: "Settings", group: "System", blurb: "Account, voice, appearance, messaging and behaviour.",
    icon: "M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2ZM12 2.8v2.4M12 18.8v2.4M4.5 7.3l2 1.2M17.5 15.5l2 1.2M4.5 16.7l2-1.2M17.5 8.5l2-1.2", keywords: "preferences account voice accent personality agent email texting"
  }
];

export const viewGroups: ViewGroup[] = ["Command", "Knowledge", "Work", "System"];

export function isViewId(value: string): value is ViewId {
  return views.some((view) => view.id === value);
}

export function viewById(id: ViewId): ViewDef {
  return views.find((view) => view.id === id) ?? views[0];
}

/** The view an address names - "#memory" - or home for anything else. */
export function viewFromHash(hash: string): ViewId {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0].toLowerCase();
  return isViewId(id) ? id : "home";
}

/**
 * What an address says within its view - "#files/app2/src" is the app2/src
 * folder - or null. Decoded once; the view decides what it means.
 */
export function detailFromHash(hash: string): string | null {
  const rest = hash.replace(/^#\/?/, "");
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  try {
    const detail = decodeURIComponent(rest.slice(slash + 1));
    return detail || null;
  } catch {
    return null;
  }
}

/** The address for a view, and something within it. */
export function hashFor(view: ViewId, detail?: string | null): string {
  return detail ? `${view}/${encodeURIComponent(detail)}` : view;
}
