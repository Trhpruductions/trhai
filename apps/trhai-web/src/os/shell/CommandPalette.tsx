"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useNav } from "../state/nav";
import { useSystem } from "../state/system";
import { useAssistantState, useConversations, useVoice } from "../state/assistant";
import { apiGet, sessionId } from "../../lib/api";
import { parentOf } from "../../lib/files";
import { sections } from "../../lib/settings";
import { views, type ViewId } from "../views";

// The command palette (Ctrl+K): go anywhere, run anything, find anything.
//
// Every result is real: the workspaces that exist, the actions the system can
// take right now, and matches from everything TRH AI keeps - conversations by
// name and by what was said in them, memories, documents, every file in the
// workspace by name and by the lines inside it, the apps it built, schedules,
// finished work, to-dos, tools and settings. Lists are read from the local
// API when the palette opens; conversations' and files' contents are searched
// as you type. And whatever you type can go straight to TRH AI, or to the web.

type Item = {
  id: string;
  group: "Actions" | "Go to" | "Settings" | "Conversations" | "Conversation" | "Memory" | "Documents" | "Files" | "Apps"
    | "Tasks" | "Schedules" | "Finished work" | "Tools" | "Ask";
  title: string;
  detail?: string;
  icon?: IconName;
  iconPath?: string;
  keys?: string;
  /** Matched however the query reads - the API already matched it, by content. */
  always?: boolean;
  run: () => void;
};

const groupOrder: Item["group"][] = [
  "Actions", "Go to", "Conversations", "Conversation", "Memory", "Documents", "Files", "Apps", "Tasks", "Schedules", "Finished work", "Tools", "Settings",
  // Last, so Enter takes the best real match - and asks only when nothing matches.
  "Ask"
];

type MemoryRow = { id: string; title: string; body: string; kind?: string; pinned?: boolean };
type ConversationRow = { id: string; title: string; preview: string; pinned: boolean; archived: boolean; match?: string };
type DocumentRow = { id: string; title: string; body?: string };
type HistoryRow = { id: string; request: string; status: string; finishedAt: string };
type AppRow = { name: string; title: string | null; request: string | null; running: boolean };
type ToolRow = { name: string; title: string; summary: string; area: string };
type Found = {
  query: string;
  names: Array<{ name: string; path: string; directory: boolean }>;
  lines: Array<{ path: string; line: number; text: string }>;
  conversations: ConversationRow[];
};

/** How well a text matches: prefix beats word start beats anywhere; 0 is no match. */
function score(text: string, query: string): number {
  const haystack = text.toLowerCase();
  if (!query) return 1;
  if (haystack.startsWith(query)) return 3;
  if (haystack.includes(` ${query}`)) return 2;
  return haystack.includes(query) ? 1 : 0;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, go, slim, setSlim, setNoticesOpen } = useNav();
  const { tasks, schedules } = useSystem();
  const assistant = useAssistantState();
  const { newConversation, openConversation } = useConversations();
  const voice = useVoice();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [found, setFound] = useState<Found | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Fresh each time it opens - the palette searches what is saved now.
  useEffect(() => {
    if (!paletteOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new search starts empty
    setQuery("");
    setSelected(0);
    setFound(null);
    window.setTimeout(() => field.current?.focus(), 0);
    const id = encodeURIComponent(sessionId());
    let cancelled = false;
    void Promise.all([
      apiGet<{ memories: MemoryRow[] }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ documents: DocumentRow[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ conversations: ConversationRow[] }>(`/v1/conversations?sessionId=${id}`),
      apiGet<{ history: HistoryRow[] }>(`/v1/agent-tasks/history?sessionId=${id}`),
      apiGet<{ apps: AppRow[] }>("/v1/apps/built"),
      apiGet<{ tools: ToolRow[] }>("/v1/tools")
    ]).then(([memoryResult, documentResult, conversationResult, historyResult, appResult, toolResult]) => {
      if (cancelled) return;
      if (memoryResult.ok) setMemories(memoryResult.data.memories);
      if (documentResult.ok) setDocuments(documentResult.data.documents);
      if (conversationResult.ok) setConversations(conversationResult.data.conversations);
      if (historyResult.ok) setHistory(historyResult.data.history);
      if (appResult.ok) setApps(appResult.data.apps);
      if (toolResult.ok) setTools(toolResult.data.tools);
    });
    return () => { cancelled = true; };
  }, [paletteOpen]);

  // What was said in conversations, and every file in the workspace by name
  // and by its lines: searched by the API a moment after typing stops. A
  // reply for words that have since changed is dropped.
  const typed = query.trim();
  useEffect(() => {
    if (!paletteOpen || typed.length < 2) return;
    let current = true;
    const timer = window.setTimeout(() => {
      const id = encodeURIComponent(sessionId());
      void Promise.all([
        apiGet<{ names: Found["names"]; lines: Found["lines"] }>(`/v1/files/search?q=${encodeURIComponent(typed)}`),
        apiGet<{ conversations: ConversationRow[] }>(`/v1/conversations?sessionId=${id}&q=${encodeURIComponent(typed)}`)
      ]).then(([files, talk]) => {
        if (!current) return;
        setFound({
          query: typed,
          names: files.ok ? files.data.names : [],
          lines: files.ok ? files.data.lines : [],
          conversations: talk.ok ? talk.data.conversations : []
        });
      });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [typed, paletteOpen]);

  const items = useMemo<Item[]>(() => {
    const close = (run: () => void) => () => { setPaletteOpen(false); run(); };
    const open = (view: ViewId, detail?: string | null) => close(() => go(view, detail));
    const iconOf = (view: ViewId) => views.find((entry) => entry.id === view)?.icon;
    const words = typed ? [
      // Whatever was typed, straight to TRH AI - or to the web.
      ...(assistant.busy ? [] : [{
        id: "act-ask", group: "Ask" as const, title: `Ask TRH AI: “${typed}”`, icon: "message" as IconName, always: true,
        run: close(() => { void assistant.send(typed); go("chat"); })
      }]),
      { id: "act-web", group: "Ask" as const, title: `Search the web for “${typed}”`, iconPath: iconOf("browser"), always: true, run: open("browser", typed) }
    ] : [];
    const actions: Item[] = [
      ...words,
      ...(assistant.busy ? [] : [{ id: "act-new-chat", group: "Actions" as const, title: "New chat", icon: "plus" as IconName, run: close(() => { newConversation(); go("chat"); }) }]),
      { id: "act-mic", group: "Actions", title: voice.mic.listening ? "Stop listening and send" : "Start voice input", icon: "mic", keys: "Alt M", run: close(() => void voice.toggleMic()) },
      { id: "act-hands", group: "Actions", title: voice.handsFree ? "Turn hands-free listening off" : "Turn hands-free listening on", icon: "wave", run: close(() => voice.setHandsFree(!voice.handsFree)) },
      {
        id: "act-speak", group: "Actions", title: voice.speech.enabled ? "Stop reading replies aloud" : "Read replies aloud",
        icon: voice.speech.enabled ? "speakerOff" : "speaker", run: close(() => voice.speech.setEnabled(!voice.speech.enabled))
      },
      { id: "act-image", group: "Actions", title: "Attach an image to the next message", icon: "image", run: close(() => assistant.openImagePicker()) },
      ...(assistant.screenShareable ? [{ id: "act-screen", group: "Actions" as const, title: "Share the screen with the next message", icon: "screen" as IconName, run: close(() => assistant.attachScreen()) }] : []),
      ...(assistant.busy ? [{ id: "act-stop", group: "Actions" as const, title: "Stop the current reply", icon: "stop" as IconName, keys: "Esc", run: close(() => assistant.stop()) }] : []),
      { id: "act-slim", group: "Actions", title: slim ? "Expand the sidebar" : "Collapse the sidebar", icon: slim ? "chevronRight" : "chevronLeft", keys: "Ctrl B", run: close(() => setSlim(!slim)) },
      { id: "act-notices", group: "Actions", title: "Show notifications", icon: "bell", run: close(() => setNoticesOpen(true)) }
    ];
    const destinations: Item[] = views.map((view, index) => ({
      id: `go-${view.id}`, group: "Go to", title: view.label, detail: view.blurb, iconPath: view.icon,
      keys: index < 10 ? `Alt ${(index + 1) % 10}` : undefined, run: open(view.id)
    }));
    const openConvo = (id: string) => close(() => { go("chat"); if (!assistant.busy) void openConversation(id); });
    // Conversations matched by what was said in them come from the API; by
    // name, from the list. One row each.
    const contentMatches = found && found.query === typed ? found.conversations : [];
    const byName = conversations.filter((conversation) => !contentMatches.some((match) => match.id === conversation.id));
    const results: Item[] = [
      ...contentMatches.map((conversation) => ({
        id: `convo-${conversation.id}`, group: "Conversations" as const, title: conversation.title, always: true,
        detail: conversation.match || conversation.preview || undefined, icon: "message" as IconName, run: openConvo(conversation.id)
      })),
      ...byName.map((conversation) => ({
        id: `convo-${conversation.id}`, group: "Conversations" as const, title: conversation.title,
        detail: conversation.preview || undefined, icon: conversation.pinned ? "pin" as IconName : "message" as IconName, run: openConvo(conversation.id)
      })),
      ...memories.map((memory) => ({
        id: `mem-${memory.id}`, group: "Memory" as const, title: memory.title || memory.body, detail: memory.body !== memory.title ? memory.body : memory.kind,
        icon: memory.pinned ? "pin" as IconName : undefined, iconPath: memory.pinned ? undefined : iconOf("memory"),
        run: open("memory")
      })),
      ...documents.map((document) => ({
        id: `doc-${document.id}`, group: "Documents" as const, title: document.title, detail: document.body?.slice(0, 90),
        iconPath: iconOf("memory"), run: open("memory")
      })),
      // Every file in the workspace, by name and by its lines; opening one
      // opens its folder in Files.
      ...(found && found.query === typed ? [
        ...found.names.map((entry) => ({
          id: `file-${entry.path}`, group: "Files" as const, title: entry.name, detail: entry.path, always: true,
          iconPath: iconOf("files"), run: open("files", entry.directory ? entry.path : parentOf(entry.path) === "." ? null : parentOf(entry.path))
        })),
        ...found.lines.map((line) => ({
          id: `line-${line.path}:${line.line}`, group: "Files" as const, title: line.text, detail: `${line.path}:${line.line}`, always: true,
          iconPath: iconOf("files"), run: open("files", parentOf(line.path) === "." ? null : parentOf(line.path))
        }))
      ] : []),
      ...apps.map((built) => ({
        id: `app-${built.name}`, group: "Apps" as const, title: built.title || built.name,
        detail: `${built.running ? "Running · " : ""}${built.request ?? built.name}`, iconPath: iconOf("code"), run: open("code")
      })),
      ...(tasks ?? []).map((task) => ({
        id: `task-${task.id}`, group: "Tasks" as const, title: task.title, detail: task.done ? "Done" : "Open",
        icon: task.done ? "check" as IconName : undefined, iconPath: task.done ? undefined : iconOf("tasks"),
        run: open("tasks")
      })),
      ...(schedules ?? []).map((schedule) => ({
        id: `sched-${schedule.id}`, group: "Schedules" as const, title: schedule.name || "A schedule",
        detail: [schedule.cadenceLabel, schedule.actionLabel].filter(Boolean).join(" · "), icon: "clock" as IconName, run: open("tasks")
      })),
      ...history.map((task) => ({
        id: `done-${task.id}`, group: "Finished work" as const, title: task.request.replace(/\s+/g, " ").slice(0, 110),
        detail: task.status === "succeeded" ? "Done" : task.status, iconPath: iconOf("tasks"), run: open("tasks")
      })),
      ...tools.map((tool) => ({
        id: `tool-${tool.name}`, group: "Tools" as const, title: tool.title, detail: `${tool.summary} · ${tool.name}`,
        iconPath: iconOf("tools"), run: open("tools")
      })),
      ...sections.map((section) => ({
        id: `set-${section.id}`, group: "Settings" as const, title: `Settings: ${section.label}`, detail: `${section.summary} ${section.keywords}`,
        iconPath: iconOf("settings"), run: open("settings", section.id === "account" ? null : section.id)
      })),
      ...assistant.messages.filter((message) => message.text.trim()).map((message) => ({
        id: `msg-${message.id}`, group: "Conversation" as const, title: message.text.replace(/\s+/g, " ").slice(0, 110),
        detail: message.role === "user" ? "You said" : "TRH AI said", iconPath: iconOf("chat"),
        run: open("chat")
      }))
    ];
    return [...actions, ...destinations, ...results];
  }, [voice, assistant, slim, setSlim, setNoticesOpen, go, setPaletteOpen, memories, documents, tasks, schedules, history, apps, tools,
    conversations, found, typed, newConversation, openConversation]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return items.filter((item) => item.group === "Actions" || item.group === "Go to");
    const ranked = items
      .map((item) => ({ item, rank: item.always ? 1 : Math.max(score(item.title, q) * 2, score(item.detail ?? "", q)) }))
      .filter((entry) => entry.rank > 0);
    // Kinds in a fixed order, the best matches first within each, and at most
    // six of any one kind so a long list cannot hide the rest.
    return groupOrder.flatMap((group) => ranked
      .filter((entry) => entry.item.group === group)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6)
      .map((entry) => entry.item));
  }, [items, q]);
  const pick = Math.min(selected, Math.max(0, shown.length - 1));

  // Keep the selected row in view as the arrows move it.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${pick}"]`)?.scrollIntoView({ block: "nearest" });
  }, [pick]);

  if (!paletteOpen) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected((pick + 1) % Math.max(1, shown.length)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setSelected((pick - 1 + shown.length) % Math.max(1, shown.length)); }
    if (event.key === "Enter") { event.preventDefault(); shown[pick]?.run(); }
    if (event.key === "Escape") { event.preventDefault(); setPaletteOpen(false); }
  };

  let lastGroup = "";
  return (
    <div className="os-palette-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
      <div className="os-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="os-palette-search">
          <Icon name="search" size={18} />
          <input
            ref={field}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search everything TRH AI keeps - or ask it, or run a command"
            aria-label="Search or run a command"
            role="combobox"
            aria-expanded="true"
            aria-controls="os-palette-results"
          />
          <kbd className="os-kbd">Esc</kbd>
        </div>
        <ul className="os-palette-results" id="os-palette-results" role="listbox" ref={list}>
          {shown.length === 0 ? (
            <li className="os-palette-none">Nothing matches &ldquo;{query}&rdquo;.</li>
          ) : shown.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id}>
                {header ? <span className="os-palette-group">{header}</span> : null}
                <button
                  type="button"
                  role="option"
                  data-index={index}
                  aria-selected={index === pick}
                  className={index === pick ? "active" : ""}
                  onMouseMove={() => setSelected(index)}
                  onClick={item.run}
                >
                  <Icon name={item.icon} path={item.iconPath} size={17} />
                  <span className="os-palette-text">
                    <span className="os-palette-title">{item.title}</span>
                    {item.detail ? <span className="os-palette-detail">{item.detail}</span> : null}
                  </span>
                  {item.keys ? <span className="os-palette-keys">{item.keys.split(" ").map((key) => <kbd key={key} className="os-kbd">{key}</kbd>)}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <footer className="os-palette-foot">
          <span><kbd className="os-kbd">↑</kbd><kbd className="os-kbd">↓</kbd> move</span>
          <span><kbd className="os-kbd">Enter</kbd> open</span>
          <span><kbd className="os-kbd">Esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
