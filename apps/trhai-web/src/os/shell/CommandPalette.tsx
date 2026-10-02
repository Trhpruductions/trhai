"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "../ui/Icon";
import { useNav } from "../state/nav";
import { useSystem } from "../state/system";
import { useAssistantState, useVoice } from "../state/assistant";
import { apiGet, sessionId } from "../../lib/api";
import { views, type ViewId } from "../views";

// The command palette (Ctrl+K): go anywhere, run anything, find anything.
//
// Every result is real: the workspaces that exist, the actions the system can
// take right now, and matches from your own memories, documents, files, tools,
// to-dos and conversation, read from the local API when the palette opens.

type Item = {
  id: string;
  group: "Actions" | "Go to" | "Memory" | "Documents" | "Files" | "Tools" | "Tasks" | "Conversation";
  title: string;
  detail?: string;
  icon?: IconName;
  iconPath?: string;
  keys?: string;
  run: () => void;
};

const groupOrder: Item["group"][] = ["Actions", "Go to", "Conversation", "Memory", "Documents", "Tasks", "Tools", "Files"];

type MemoryRow = { id: string; title: string; body: string; kind?: string; pinned?: boolean };
type DocumentRow = { id: string; title: string; body?: string };
type FileRow = { path: string; directory: boolean; bytes: number };

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
  const { capabilities, tasks } = useSystem();
  const assistant = useAssistantState();
  const voice = useVoice();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Fresh each time it opens - the palette searches what is saved now.
  useEffect(() => {
    if (!paletteOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new search starts empty
    setQuery("");
    setSelected(0);
    window.setTimeout(() => field.current?.focus(), 0);
    const id = encodeURIComponent(sessionId());
    let cancelled = false;
    void Promise.all([
      apiGet<{ memories: MemoryRow[] }>(`/v1/assist/memory?sessionId=${id}`),
      apiGet<{ documents: DocumentRow[] }>(`/v1/knowledge?sessionId=${id}`),
      apiGet<{ entries: FileRow[] }>("/v1/files")
    ]).then(([memoryResult, documentResult, fileResult]) => {
      if (cancelled) return;
      if (memoryResult.ok) setMemories(memoryResult.data.memories);
      if (documentResult.ok) setDocuments(documentResult.data.documents);
      if (fileResult.ok) setFiles(fileResult.data.entries);
    });
    return () => { cancelled = true; };
  }, [paletteOpen]);

  const items = useMemo<Item[]>(() => {
    const close = (run: () => void) => () => { setPaletteOpen(false); run(); };
    const open = (view: ViewId) => close(() => go(view));
    const actions: Item[] = [
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
    const found: Item[] = [
      ...memories.map((memory) => ({
        id: `mem-${memory.id}`, group: "Memory" as const, title: memory.title || memory.body, detail: memory.body !== memory.title ? memory.body : memory.kind,
        icon: memory.pinned ? "pin" as IconName : undefined, iconPath: memory.pinned ? undefined : views.find((view) => view.id === "memory")?.icon,
        run: open("memory")
      })),
      ...documents.map((document) => ({
        id: `doc-${document.id}`, group: "Documents" as const, title: document.title, detail: document.body?.slice(0, 90),
        iconPath: views.find((view) => view.id === "memory")?.icon, run: open("memory")
      })),
      // Version-control and dependency internals are not files anyone means.
      ...files.filter((file) => !file.directory && !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(file.path)).map((file) => ({
        id: `file-${file.path}`, group: "Files" as const, title: file.path.split(/[\\/]/).pop() ?? file.path, detail: file.path,
        iconPath: views.find((view) => view.id === "files")?.icon, run: open("files")
      })),
      ...(capabilities?.tools ?? []).map((tool) => ({
        id: `tool-${tool.name}`, group: "Tools" as const, title: tool.name.replace(/_/g, " "), detail: tool.levelLabel,
        iconPath: views.find((view) => view.id === "tools")?.icon, run: open("tools")
      })),
      ...(tasks ?? []).map((task) => ({
        id: `task-${task.id}`, group: "Tasks" as const, title: task.title, detail: task.done ? "Done" : "Open",
        icon: task.done ? "check" as IconName : undefined, iconPath: task.done ? undefined : views.find((view) => view.id === "tasks")?.icon,
        run: open("tasks")
      })),
      ...assistant.messages.filter((message) => message.text.trim()).map((message) => ({
        id: `msg-${message.id}`, group: "Conversation" as const, title: message.text.replace(/\s+/g, " ").slice(0, 110),
        detail: message.role === "user" ? "You said" : "TRH AI said", iconPath: views.find((view) => view.id === "chat")?.icon,
        run: open("chat")
      }))
    ];
    return [...actions, ...destinations, ...found];
  }, [voice, assistant, slim, setSlim, setNoticesOpen, go, setPaletteOpen, memories, documents, files, capabilities, tasks]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return items.filter((item) => item.group === "Actions" || item.group === "Go to");
    const ranked = items
      .map((item) => ({ item, rank: Math.max(score(item.title, q) * 2, score(item.detail ?? "", q)) }))
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
            placeholder="Search memory, files, tools and conversation - or run a command"
            aria-label="Search or run a command"
            role="combobox"
            aria-expanded="true"
            aria-controls="os-palette-results"
          />
          <kbd className="os-kbd">Esc</kbd>
        </div>
        <ul className="os-palette-results" id="os-palette-results" role="listbox" ref={list}>
          {shown.length === 0 ? (
            <li className="os-palette-none">Nothing matches &ldquo;{query}&rdquo;. Press Enter in the command bar to ask TRH AI instead.</li>
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
