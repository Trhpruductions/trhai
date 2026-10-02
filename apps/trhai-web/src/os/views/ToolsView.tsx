"use client";

import { CommandAccess } from "../../components/CommandAccess";
import { ViewFrame } from "../ui/ViewFrame";
import { useSystem } from "../state/system";
import "./views.css";

export function ToolsView() {
  const { capabilities } = useSystem();
  const tools = capabilities?.tools ?? [];
  return (
    <ViewFrame id="tools" actions={<span className="os-chip accent">{capabilities ? `${tools.length} tools` : "Loading…"}</span>}>
      <section className="os-panel">
        <header className="os-panel-head"><h3 className="os-panel-title">Available tools</h3></header>
        <div className="os-panel-body">
          {tools.length === 0 ? (
            <div className="os-empty"><strong>{capabilities ? "No tools reported" : "Reading the tool registry…"}</strong></div>
          ) : (
            <ul className="os-tool-grid">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <span className="os-mono">{tool.name}</span>
                  <span className={`os-chip ${tool.level >= 4 ? "danger" : tool.level >= 3 ? "warn" : tool.level >= 2 ? "accent" : "ok"}`}>{tool.levelLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <CommandAccess active />
    </ViewFrame>
  );
}
