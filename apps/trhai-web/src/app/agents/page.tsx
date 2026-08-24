"use client";

import { useEffect, useState } from "react";
import {
  activateAgent,
  allAgents,
  formatInstalls,
  installAgent,
  isInstalled,
  latestVersion,
  readMarketplaceState,
  uninstallAgent,
  writeMarketplaceState,
  type MarketplaceState
} from "@ascend/shared";
import { marketplaceStorageKey } from "../../lib/agents";
import "./agents.css";

// Agents: installable lenses on the same assistant (packages/shared's
// marketplace.ts). An installed agent changes the suggestions and focus
// line the dashboard shows — see page.tsx — and nothing about what TRHAI is
// allowed to do; that boundary is enforced in @ascend/shared itself, not
// here, so this screen has no way to grant a capability even by mistake.

export default function AgentsPage() {
  const [state, setState] = useState<MarketplaceState>({ installed: [], activeAgentId: null });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setState(readMarketplaceState(window.localStorage, marketplaceStorageKey));
    setLoaded(true);
  }, []);

  function commit(next: MarketplaceState) {
    setState(next);
    writeMarketplaceState(window.localStorage, marketplaceStorageKey, next);
  }

  const agents = [...allAgents()].sort((a, b) => {
    const ai = isInstalled(state, a.id) ? 0 : 1;
    const bi = isInstalled(state, b.id) ? 0 : 1;
    return ai - bi;
  });

  return (
    <div className="agents">
      <header className="agents-head">
        <h1>Agents</h1>
        <p className="muted">
          An installed agent changes what the dashboard suggests and its one-line focus. It is a
          lens on the same assistant, like a personality — it does not grant new abilities.
        </p>
      </header>

      {!loaded ? null : (
        <div className="agents-grid">
          {agents.map((agent) => {
            const installed = isInstalled(state, agent.id);
            const active = state.activeAgentId === agent.id;
            const version = latestVersion(agent);

            return (
              <article key={agent.id} className={`panel agent-card${active ? " active" : ""}`}>
                <header className="agents-row">
                  <span className="agent-avatar" aria-hidden="true">{agent.avatar}</span>
                  <div className="grow">
                    <strong>{agent.name}</strong>
                    <div className="faint">{agent.role}</div>
                  </div>
                  {active ? <span className="chip chip-live">Active</span> : null}
                </header>

                <p className="muted agent-desc">{agent.description}</p>

                <div className="agents-row agents-wrap">
                  <span className="chip">★ {agent.rating.toFixed(1)}</span>
                  <span className="chip">{formatInstalls(agent.installs)} installs</span>
                  <span className="faint">catalogue figures, not measured here</span>
                </div>

                <p className="faint agent-version">v{version.version} · {version.releasedOn}</p>

                <div className="agents-row">
                  {installed ? (
                    <>
                      <button type="button" className="btn btn-sm" disabled={active}
                        onClick={() => commit(activateAgent(state, agent.id))}>
                        {active ? "Active" : "Make active"}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm"
                        onClick={() => commit(uninstallAgent(state, agent.id))}>
                        Uninstall
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-primary btn-sm"
                      onClick={() => commit(installAgent(state, agent.id))}>
                      Install
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
