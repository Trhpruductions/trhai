"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Core } from "../components/Core";
import { apiBaseUrl } from "../lib/api";
import "./dash.css";

// Dashboard: the command centre.
//
// Phase 1 of the rewrite is the core shell — chat, voice, settings, theme,
// navigation. Tasks, live system telemetry, security and automation are
// later phases in the same plan, so this screen shows what is real today
// (whether TRHAI can actually answer, right now) rather than empty widgets
// standing in for panels that do not exist yet.

type ModelInfo = { available: true; model: string } | { available: false; reason: string };

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function DashboardPage() {
  const router = useRouter();
  const [online, setOnline] = useState<boolean | null>(null);
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const ticker = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/assist/model`);
        if (cancelled) return;
        setOnline(response.ok);
        if (response.ok) {
          const payload = await response.json();
          setInfo(payload?.data?.available
            ? { available: true, model: payload.data.model }
            : { available: false, reason: payload?.data?.reason ?? "No local model is running." });
        }
      } catch {
        if (!cancelled) setOnline(false);
      }
    }

    void probe();
    const poller = window.setInterval(probe, 5000);
    return () => { cancelled = true; window.clearInterval(poller); };
  }, []);

  function askAndGo() {
    const trimmed = draft.trim();
    if (!trimmed) { router.push("/chat"); return; }
    // Handed to the chat screen through the same session-scoped storage the
    // chat hook already reads on mount — no query string carrying a message
    // where it could end up logged or shared.
    window.sessionStorage.setItem("trhai.dashboard.seed", trimmed);
    router.push("/chat");
  }

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <span className="hud-label">TRHAI</span>
          <h1>{greetingFor(clock)}, Hank</h1>
        </div>
        <span className="mono dash-clock">
          {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      </header>

      <div className="dash-core-wrap">
        <Core state={online === false ? "offline" : "idle"} size={220} />
      </div>

      <div className="dash-status panel">
        <span className="hud-label">AI Status</span>
        {online === null ? (
          <p className="muted">Checking the local service…</p>
        ) : online && info?.available ? (
          <p>
            <span className="chip chip-ok">Online</span>{" "}
            Answering with <span className="mono">{info.model.replace(/:latest$/, "")}</span>.
          </p>
        ) : online ? (
          <p>
            <span className="chip chip-warn">Reachable, no model</span>{" "}
            {info && !info.available ? info.reason : "No local model is running."}
          </p>
        ) : (
          <p>
            <span className="chip chip-danger">Offline</span>{" "}
            The local API is not responding. Start it and this updates on its own.
          </p>
        )}
      </div>

      <div className="dash-ask panel">
        <label className="hud-label" htmlFor="dash-ask-input">What would you like me to do?</label>
        <div className="dash-ask-row">
          <input
            id="dash-ask-input"
            className="field"
            value={draft}
            placeholder="Ask anything, or describe something to build…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") askAndGo(); }}
          />
          <button type="button" className="btn btn-primary" onClick={askAndGo}>Go</button>
        </div>
      </div>

      <p className="dash-note faint">
        Tasks, live system telemetry, security and automation are later phases of the same
        build — they will appear here once they are real, not before.
      </p>
    </div>
  );
}
