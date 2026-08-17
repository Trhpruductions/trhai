import { useState } from "react";
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
} from "../../marketplace";
import { Surface } from "../Surface";

// Agents: installable lenses on the same assistant.
//
// The marketplace and the installed list were separate destinations before,
// which meant an empty "Agents" screen telling you to go somewhere else. One
// screen, with installed ones first.

const storageKey = "ascend.marketplace.v1";

export function AgentsSurface() {
  const [state, setState] = useState<MarketplaceState>(() => readMarketplaceState(window.localStorage, storageKey));

  function commit(next: MarketplaceState) {
    setState(next);
    writeMarketplaceState(window.localStorage, storageKey, next);
  }

  // Installed first, then the rest — the list is short enough that hiding the
  // uninstalled ones behind a tab would cost more than it saves.
  const agents = [...allAgents()].sort((a, b) => {
    const ai = isInstalled(state, a.id) ? 0 : 1;
    const bi = isInstalled(state, b.id) ? 0 : 1;
    return ai - bi;
  });

  return (
    <Surface
      title="Agents"
      summary="An installed agent changes the assistant's focus and the prompts it suggests. It does not grant new abilities — it is a lens on the same assistant, like a personality."
      count={`${state.installed.length} installed`}
      readable={false}
    >
      <div className="agent-grid">
        {agents.map((agent) => {
          const installed = isInstalled(state, agent.id);
          const active = state.activeAgentId === agent.id;
          const version = latestVersion(agent);

          return (
            <article key={agent.id} className={`panel agent${active ? " active" : ""}`}>
              <header className="row">
                <span className="agent-avatar" aria-hidden="true">{agent.avatar}</span>
                <div className="grow">
                  <strong>{agent.name}</strong>
                  <div className="faint">{agent.role}</div>
                </div>
                {active ? <span className="chip chip-live">Active</span> : null}
              </header>

              <p className="muted agent-desc">{agent.description}</p>

              <div className="row wrap agent-signal">
                <span className="chip">★ {agent.rating.toFixed(1)}</span>
                <span className="chip">{formatInstalls(agent.installs)} installs</span>
                {/* Labelled, because these are the catalogue's published figures
                    and not anything measured on this machine. */}
                <span className="faint">catalogue figures, not measured here</span>
              </div>

              <details className="agent-versions">
                <summary className="faint">v{version.version} · {version.releasedOn}</summary>
                <ul>
                  {agent.versions.map((entry) => (
                    <li key={entry.version}>
                      <span className="mono">v{entry.version}</span> <span className="faint">{entry.releasedOn}</span>
                      <div className="muted">{entry.notes}</div>
                    </li>
                  ))}
                </ul>
              </details>

              <div className="row agent-actions">
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
    </Surface>
  );
}
