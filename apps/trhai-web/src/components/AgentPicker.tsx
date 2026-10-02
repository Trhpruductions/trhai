"use client";

import { allAgents, type Agent } from "@ascend/shared";
import "./personality.css";

// Choosing an agent to work as.
//
// The catalogue came over from Vexora into @ascend/shared, and nothing in
// TRHAI could choose from it: the card that did went with the surfaces, so the
// only active agent possible was one left over in storage - and all that one
// changed was a list of suggestion chips the screen no longer draws. Chosen
// here, the agent now reaches the model: the API puts its role, description
// and focus into the system prompt (see describeAgentLens). The tools, the
// permission gates and the honesty rules are the same whichever is active.
//
// Next to the personality, because it is the same kind of setting: how TRHAI
// answers, not what it can do.

export function AgentPicker({ active, onChange }: {
  active: Agent | null;
  onChange: (id: string | null) => void;
}) {
  const agents = allAgents();

  return (
    <section className="hud-panel persona-pick">
      <span className="hud-label">Agent</span>

      <select
        className="persona-select"
        value={active?.id ?? ""}
        aria-label="Which agent TRHAI works as"
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">None - TRHAI as itself</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>{`${agent.avatar} ${agent.name} - ${agent.role}`}</option>
        ))}
      </select>

      {/* The catalogue's own words, so this cannot drift from what the model is
          actually told - the description is passed to it whole. */}
      {active ? (
        <>
          <p className="persona-summary">{active.description}</p>
          <p className="persona-summary">
            <span className="agent-focus-label">Keeps in view</span>
            {active.focus}
          </p>
          {/* The real string appended to every reply, as the personality
              picker shows its own. */}
          {active.mandatoryDisclaimer ? (
            <p className="persona-disclaimer">
              <span className="persona-disclaimer-label">Every reply carries:</span>
              {active.mandatoryDisclaimer}
            </p>
          ) : null}
        </>
      ) : (
        <p className="persona-summary">
          Pick one and TRHAI answers with that role&apos;s focus. The tools and the rules stay the same.
        </p>
      )}
    </section>
  );
}
