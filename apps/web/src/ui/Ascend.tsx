import { useEffect, useState } from "react";
import { AppShell, type SurfaceContext, type SurfaceId } from "./AppShell";
import { Surface, Empty } from "./Surface";
import { BuildSurface } from "./surfaces/BuildSurface";
import { KnowledgeSurface } from "./surfaces/KnowledgeSurface";
import { MemorySurface } from "./surfaces/MemorySurface";
import { SettingsSurface } from "./surfaces/SettingsSurface";
import { CalendarSurface } from "./surfaces/CalendarSurface";
import { AgentsSurface } from "./surfaces/AgentsSurface";
import { webEnv } from "../env";
import "../design/tokens.css";
import "../design/base.css";
import "./surfaces/surfaces.css";

// Composition root for the rebuilt UI.
//
// Deliberately thin: it owns the model-status probe and the mapping from a
// surface id to a screen, and nothing else. The previous entry point was one
// 5,600-line component that owned every piece of state in the app, which is
// how a prompt box ended up wired to the wrong subsystem.

/**
 * Whether a local model is answering.
 *
 * Asked at startup and then on a slow interval, because the user can start or
 * stop Ollama at any time and a stale indicator would misreport what the
 * assistant can do. The question goes to our own API, so the browser never has
 * to reach a second origin.
 */
function useModelStatus(): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/model`);
        if (!response.ok) return;
        const payload = await response.json();
        if (!cancelled) setLabel(payload?.data?.model ?? null);
      } catch {
        if (!cancelled) setLabel(null);
      }
    }

    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  return label;
}

function renderSurface(id: SurfaceId, context: SurfaceContext) {
  switch (id) {
    case "build":
      return <BuildSurface context={context} />;
    case "knowledge":
      return <KnowledgeSurface />;
    case "memory":
      return <MemorySurface />;
    case "calendar":
      return <CalendarSurface />;
    case "agents":
      return <AgentsSurface />;
    case "settings":
      return <SettingsSurface context={context} />;
    case "automation":
      // The flow canvas is the one screen still on the old shell. Said plainly
      // rather than shown as an empty panel, which is indistinguishable from a
      // broken one.
      return (
        <Surface
          title="Automation"
          summary="Block-based flows: control flow and scripts run for real, steps needing credentials are dry-run only."
        >
          <Empty title="Still on the previous interface">
            The flow engine is unchanged and covered by tests — only this screen has yet to be
            rebuilt. Open the app with <span className="mono">?ui=classic</span> to use it in the
            meantime.
          </Empty>
        </Surface>
      );
    default:
      return null;
  }
}

export function Ascend() {
  const modelLabel = useModelStatus();

  return <AppShell modelLabel={modelLabel} renderSurface={renderSurface} />;
}
