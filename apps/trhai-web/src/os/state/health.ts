"use client";

import { useMemo } from "react";
import { useSystem } from "./system";
import { useVoice } from "./assistant";

// The checks every health readout uses - the same six the old dashboard
// showed, each from a real answer. A row still being checked counts neither
// way; "stability" is the share of decided checks that passed, a number that
// drops when something breaks rather than a dial pinned near 100%.

/** One check of one part of TRH AI: its name, what it found, and whether that is good. */
export type HealthRow = { label: string; state: string; ok: boolean | null };

export type ModuleState = "online" | "standby" | "offline";

export function useHealth() {
  const { online, model, stt, schedules, schedulePersistError, capabilities } = useSystem();
  const { speech, mic } = useVoice();

  return useMemo(() => {
    const rows: HealthRow[] = [
      { label: "Local API", state: online === null ? "checking" : online ? "connected" : "unreachable", ok: online },
      { label: "Model", state: model === null ? "checking" : model.available ? "loaded" : "none", ok: model === null ? null : model.available },
      {
        label: "Voice", state: speech.neural === null ? "checking" : speech.neural.available ? "ready" : "absent",
        ok: speech.neural === null ? null : speech.neural.available
      },
      { label: "Transcription", state: stt === null ? "checking" : stt.available ? "ready" : "absent", ok: stt === null ? null : stt.available },
      {
        label: "Scheduler", state: schedules === null ? "checking" : schedulePersistError === null ? "running" : "not saving",
        ok: schedules === null ? null : schedulePersistError === null
      },
      {
        label: "Video render", state: capabilities === null ? "checking" : capabilities.videoRendering ? "ready" : "absent",
        ok: capabilities === null ? null : capabilities.videoRendering === true
      }
    ];
    const decided = rows.filter((row) => row.ok !== null);
    const health = decided.length === 0 ? null : { passed: decided.filter((row) => row.ok === true).length, total: decided.length };
    const failing = decided.filter((row) => row.ok === false).length;

    // Each module is a capability that is genuinely wired, and its state is read.
    const modules: Array<{ name: string; state: ModuleState; detail: string }> = [
      {
        name: "Neural processor", state: model?.available ? "online" : "offline",
        detail: model?.available ? (model.model ?? "local model").replace(/^(?:local|ollama)\//, "") : model?.reason ?? "No local model"
      },
      {
        name: "Voice engine", state: speech.engine !== "none" ? "online" : "offline",
        detail: speech.engine === "neural" ? "Neural voice (Piper)" : speech.engine === "browser" ? "Browser voice" : "No speech engine"
      },
      {
        name: "Speech recognition", state: mic.supported && stt?.available ? "online" : "offline",
        detail: stt?.available ? `Whisper ${stt.model ?? ""}`.trim() : stt?.reason ?? "Not installed"
      },
      { name: "Memory core", state: online ? "online" : "offline", detail: "Saved on this PC" },
      { name: "Web access", state: capabilities?.web ? "standby" : "offline", detail: capabilities?.web ? "Reads pages and searches when asked" : "Off" },
      {
        name: "Code executor", state: capabilities?.codeExecution ? "standby" : "offline",
        detail: capabilities?.codeExecution ? "Runs commands with your approval" : "Machine control is off"
      }
    ];
    return { rows, health, failing, modules };
  }, [online, model, stt, schedules, schedulePersistError, capabilities, speech.neural, speech.engine, mic.supported]);
}
