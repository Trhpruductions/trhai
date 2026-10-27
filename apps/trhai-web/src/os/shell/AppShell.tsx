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
import { PaywallScreen } from "../../components/PaywallScreen";
import { UpdateNotices } from "../../components/UpdateNotices";
import { SetupScreen } from "../../components/SetupScreen";
import { MusicVideoWatcher } from "../../components/MusicVideoWatcher";
import { RequiredSetupBanner } from "../../components/RequiredSetupBanner";
import { RequiredUpdate } from "../../components/RequiredUpdate";
import { useNav } from "../state/nav";
import { useAssistantState, useVoice } from "../state/assistant";
import { looksLikeSong } from "../../lib/songAttach";
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
  browser: dynamic(() => import("../views/BrowserView").then((module) => module.BrowserView), { loading: ViewLoading }),
  code: dynamic(() => import("../views/CodeView").then((module) => module.CodeView), { loading: ViewLoading }),
  tasks: dynamic(() => import("../views/TasksView").then((module) => module.TasksView), { loading: ViewLoading }),
  automation: dynamic(() => import("../views/AutomationView").then((module) => module.AutomationView), { loading: ViewLoading }),
  tools: dynamic(() => import("../views/ToolsView").then((module) => module.ToolsView), { loading: ViewLoading }),
  music: dynamic(() => import("../views/MusicVideoView").then((module) => module.MusicVideoView), { loading: ViewLoading }),
  system: dynamic(() => import("../views/SystemView").then((module) => module.SystemView), { loading: ViewLoading }),
  network: dynamic(() => import("../views/NetworkView").then((module) => module.NetworkView), { loading: ViewLoading }),
  settings: dynamic(() => import("../views/SettingsView").then((module) => module.SettingsView), { loading: ViewLoading })
};

export function AppShell() {
  const { view, go, slim, setSlim, paletteOpen, setPaletteOpen, noticesOpen, setNoticesOpen } = useNav();
  const { core, attentive, addFiles, busy, stop } = useAssistantState();
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
    notices: <NotificationCenter />, toasts: <Toasts />, palette: <CommandPalette />,
    // Over every screen, for everyone using the app: the update notices, and
    // the paywall once a trial or license has run out (it sits above them).
    setup: <SetupScreen />, updates: <UpdateNotices />, paywall: <PaywallScreen />, musicWatcher: <MusicVideoWatcher />,
    // What an update installs by itself (new models, voices and tools), and how far it has got.
    requiredSetup: <RequiredSetupBanner />,
    // A release marked required: downloaded by itself and installed, over everything.
    requiredUpdate: <RequiredUpdate />
  }), []);

  return (
    <BackdropAnchorProvider value={setCoreAnchor}>
      <div className={`os${slim ? " os-slim" : ""}${attentive ? " os-attentive" : ""}`} data-core={core}>
        <Backdrop anchor={coreAnchor} home={view === "home"} />
        {chrome.sidebar}
        <div className="os-main">
          {chrome.topbar}
          {chrome.requiredSetup}
          <main
            ref={workspace}
            className="os-workspace"
            id="os-workspace"
            tabIndex={-1}
            aria-label={viewById(view).label}
            // An image dropped anywhere on a workspace goes with the next message; a song
            // opens the music video maker with it. A file with no type yet (some song
            // formats have none registered) is let in: only its name tells what it is.
            onDragOver={(event) => {
              if ([...event.dataTransfer.items].some((item) => item.kind === "file" && (item.type === "" || item.type.startsWith("image/") || item.type.startsWith("audio/")))) event.preventDefault();
            }}
            onDrop={(event) => {
              // A song dropped on the maker's own box was taken there already: not twice.
              const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/") || (!event.defaultPrevented && looksLikeSong(file)));
              if (files.length === 0) return;
              event.preventDefault();
              void addFiles(files);
            }}
          >
            {content}
          </main>
          {chrome.commandbar}
        </div>
        {chrome.notices}
        {chrome.toasts}
        {chrome.palette}
        {chrome.setup}
        {chrome.updates}
        {chrome.requiredUpdate}
        {chrome.paywall}
        {chrome.musicWatcher}
      </div>
    </BackdropAnchorProvider>
  );
}
