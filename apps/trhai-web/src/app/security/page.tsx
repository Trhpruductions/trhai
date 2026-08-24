"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../../lib/api";
import "./security.css";

// Security: what TRHAI is actually allowed to do, read from the same
// registry runTool enforces (GET /v1/capabilities, wrapping
// systemCapabilities.ts) rather than a page that describes the tool set from
// memory and can drift from what the permission gate actually allows.

type ToolCapability = {
  name: string;
  description: string;
  levelLabel: string;
  requiresConfirmation: boolean;
};

type Capabilities = {
  model: string | null;
  tools: ToolCapability[];
  groups: Array<{ label: string; tools: ToolCapability[] }>;
  filesystem: boolean;
  memory: boolean;
  documents: boolean;
  web: boolean;
  codeExecution: boolean;
  applicationBuilding: boolean;
  integrations: string[];
};

const areas: Array<{ key: keyof Capabilities; label: string }> = [
  { key: "filesystem", label: "Filesystem" },
  { key: "memory", label: "Memory" },
  { key: "documents", label: "Documents" },
  { key: "web", label: "Web" },
  { key: "applicationBuilding", label: "App building" },
  { key: "codeExecution", label: "Code execution" }
];

export default function SecurityPage() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const result = await apiGet<Capabilities>("/v1/capabilities");
      if (cancelled) return;
      if (result.ok) {
        setCapabilities(result.data);
      } else {
        setError(result.reason);
      }
    }

    void load();
  }, []);

  return (
    <div className="security">
      <header className="security-head">
        <h1>Security</h1>
        <p className="muted">
          Every tool TRHAI can call, and the permission level that gates it. This is not a
          description of the registry — it is the registry.
        </p>
      </header>

      {error ? (
        <div className="panel security-card">
          <p className="muted">{error}</p>
        </div>
      ) : !capabilities ? (
        <div className="panel security-card">
          <p className="muted">Reading the local service…</p>
        </div>
      ) : (
        <>
          <div className="panel security-card">
            <span className="hud-label">Areas</span>
            <div className="security-areas">
              {areas.map((area) => (
                <span key={area.key} className={`chip${capabilities[area.key] ? " chip-ok" : ""}`}>
                  {capabilities[area.key] ? "✓" : "✕"} {area.label}
                </span>
              ))}
            </div>
            <p className="faint security-note">
              {capabilities.integrations.length === 0
                ? "No third-party integrations connected."
                : `Connected: ${capabilities.integrations.join(", ")}.`}
            </p>
          </div>

          {capabilities.groups.map((group) => (
            <div key={group.label} className="panel security-card">
              <span className="hud-label">{group.label}</span>
              <ul className="security-tool-list">
                {group.tools.map((tool) => (
                  <li key={tool.name} className="security-tool">
                    <div className="security-tool-head">
                      <strong className="mono">{tool.name}</strong>
                      {tool.requiresConfirmation ? (
                        <span className="chip chip-warn">needs confirmation</span>
                      ) : null}
                    </div>
                    <p className="faint">{tool.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
