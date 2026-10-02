"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Backdrop, BackdropAnchorProvider } from "./Backdrop";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandBar } from "./CommandBar";
import { CommandPalette } from "./CommandPalette";
import { NotificationCenter, Toasts } from "./Notifications";
import { ViewBoundary } from "../ui/SystemAlert";
import { useNav } from "../state/nav";
import { useAssistantState, useVoice } from "../state/assistant";
import { views, viewById, type ViewId } from "../views";

// The operating environment's frame: navigation down the side, status across
// the top, the command bar along the bottom, and one workspace in the middle.
//
// Workspaces load when first opened rather than all up front, so the first
// screen arrives without carrying code for screens nobody has opened yet.

function ViewLoading() {
  return (
    <div className="os-view" aria-busy="true">
      <div className="os-skeleton os-skeleton-title" />
      <div className="os-grid os-grid-2">
        <div className="os-skeleton os-skeleton-panel" />
        <div className="os-skeleton os-skeleton-panel" />
      </div>
    </div>
  );
}

const loaders: Record<ViewId, ReturnType<typeof dynamic>> = {
  home: dynamic(() => import("../home/HomeView").then((module) => module.HomeView), { loading: ViewLoading }),
  chat: dynamic(() => import("../views/ChatView").then((module) => module.ChatView), { loading: ViewLoading }),
  voice: dynamic(() => import("../views/VoiceView").then((module) => module.VoiceView), { loading: ViewLoading }),
  memory: dynamic(() => import("../views/MemoryView").then((module) => module.MemoryView), { loading: ViewLoading }),
  files: dynamic(() => import("../views/FilesView").then((module) => module.FilesView), { loading: ViewLoading }),
  code: dynamic(() => import("../views/CodeView").then((module) => module.CodeView), { loading: ViewLoading }),
  tasks: dynamic(() => import("../views/TasksView").then((module) => module.TasksView), { loading: ViewLoading }),
  tools: dynamic(() => import("../views/ToolsView").then((module) => module.ToolsView), { loading: ViewLoading }),
  system: dynamic(() => import("../views/SystemView").then((module) => module.SystemView), { loading: ViewLoading }),
  network: dynamic(() => import("../views/NetworkView").then((module) => module.NetworkView), { loading: ViewLoading }),
  settings: dynamic(() => import("../views/SettingsView").then((module) => module.SettingsView), { loading: ViewLoading })
};

export function AppShell() {
  const { view, go, slim, setSlim, paletteOpen, setPaletteOpen, noticesOpen, setNoticesOpen } = useNav();
  const { core, attentive, addImages, busy, stop } = useAssistantState();
  const { toggleMic } = useVoice();
  const workspace = useRef<HTMLElement>(null);
  // Home's core, once it is on screen: the backdrop puts the art's globe under it.
  const [coreAnchor, setCoreAnchor] = useState<HTMLElement | null>(null);

  // The system's own shortcuts. Ctrl+K, Ctrl+B and Alt+M work from anywhere,
  // including the command bar; Alt+number moves between workspaces.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") { event.preventDefault(); setPaletteOpen(!paletteOpen); return; }
      if (mod && key === "b") { event.preventDefault(); setSlim(!slim); return; }
      if (event.altKey && !mod && key === "m") { event.preventDefault(); void toggleMic(); return; }
      if (event.altKey && !mod && /^[0-9]$/.test(event.key)) {
        const index = event.key === "0" ? 9 : Number(event.key) - 1;
        const target = views[index];
        if (target) { event.preventDefault(); go(target.id); }
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) { setPaletteOpen(false); return; }
        if (noticesOpen) { setNoticesOpen(false); return; }
        if (busy && !(event.target instanceof HTMLTextAreaElement)) stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen, slim, setSlim, toggleMic, go, noticesOpen, setNoticesOpen, busy, stop]);

  // A new workspace starts at its top.
  useEffect(() => {
    workspace.current?.scrollTo({ top: 0 });
  }, [view]);

  // The same element objects every render, so React skips re-rendering them
  // when only this frame changes (the core's state while a reply streams):
  // each one still updates whenever the context it reads changes.
  const View = loaders[view];
  const content = useMemo(() => (
    <ViewBoundary key={view} name={viewById(view).label}>
      <View />
    </ViewBoundary>
  ), [view, View]);
  const chrome = useMemo(() => ({
    sidebar: <Sidebar />, topbar: <TopBar />, commandbar: <CommandBar />,
    notices: <NotificationCenter />, toasts: <Toasts />, palette: <CommandPalette />
  }), []);

  return (
    <BackdropAnchorProvider value={setCoreAnchor}>
      <div className={`os${slim ? " os-slim" : ""}${attentive ? " os-attentive" : ""}`} data-core={core}>
        <Backdrop anchor={coreAnchor} home={view === "home"} />
        {chrome.sidebar}
        <div className="os-main">
          {chrome.topbar}
          <main
            ref={workspace}
            className="os-workspace"
            id="os-workspace"
            tabIndex={-1}
            aria-label={viewById(view).label}
            // An image dropped anywhere on a workspace goes with the next message.
            onDragOver={(event) => {
              if ([...event.dataTransfer.items].some((item) => item.kind === "file" && item.type.startsWith("image/"))) event.preventDefault();
            }}
            onDrop={(event) => {
              const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
              if (files.length === 0) return;
              event.preventDefault();
              void addImages(files);
            }}
          >
            {content}
          </main>
          {chrome.commandbar}
        </div>
        {chrome.notices}
        {chrome.toasts}
        {chrome.palette}
      </div>
    </BackdropAnchorProvider>
  );
}
