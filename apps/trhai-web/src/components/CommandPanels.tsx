"use client";

import Link from "next/link";
import "./panels.css";

// The right-hand column of the command centre.
//
// Each panel matches one from the reference design and is filled from a real
// source. Two of them are deliberately not what the reference shows, and both
// for the same reason:
//
// ACTIVE TASKS has no progress bars. The reference shows "Project Analysis
// 72%", and nothing in this system knows how far through a request it is —
// a bar filling to 72% would be an animation with a number written on it.
// What is real is the status: planned, executing, succeeded, failed, blocked.
//
// CONNECTED SERVICES is empty, and says so. The reference shows VS Code,
// GitHub, Discord, OpenAI and YouTube tiles. This build talks to none of
// them; drawing their logos would claim five integrations that do not exist,
// on the screen whose whole job is telling you what is actually running.

export type HealthRow = { label: string; state: string; ok: boolean | null };

/**
 * Overall health, as a fraction of the checks that actually passed.
 *
 * The reference shows a fixed 100%. This counts: four of five subsystems
 * reachable reads 80%, and the row that failed is right underneath saying
 * which one. A dial permanently at 100% is decoration — it cannot tell you
 * anything, because it never moves.
 */
export function SystemOverview({ rows }: { rows: HealthRow[] }) {
  const known = rows.filter((row) => row.ok !== null);
  const passing = known.filter((row) => row.ok).length;
  const health = known.length === 0 ? null : Math.round((passing / known.length) * 100);

  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const filled = health === null ? 0 : circumference * (health / 100);
  const tone = health === null ? "unknown" : health === 100 ? "ok" : health >= 60 ? "warn" : "danger";

  return (
    <section className="hud-panel">
      <span className="hud-label">System overview</span>
      <div className="overview">
        <div className={`health health-${tone}`}>
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <circle className="health-track" cx="32" cy="32" r={radius} />
            {health !== null ? (
              <circle
                className="health-fill" cx="32" cy="32" r={radius}
                strokeDasharray={`${filled} ${circumference - filled}`}
                transform="rotate(-90 32 32)"
              />
            ) : null}
          </svg>
          <span className="health-value">{health === null ? "—" : `${health}%`}</span>
          <span className="health-word">health</span>
        </div>

        <dl className="overview-rows">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd className={row.ok === null ? "" : row.ok ? "ok" : "danger"}>
                {row.state}
                <span className={`overview-dot${row.ok ? " on" : row.ok === false ? " off" : ""}`} aria-hidden="true" />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export type AgentTask = {
  id: string;
  status: "planned" | "executing" | "succeeded" | "failed" | "blocked";
  request: string;
  taskType: string;
  toolsUsed: string[];
  error?: string;
  updatedAt: string;
};

const statusWords: Record<AgentTask["status"], string> = {
  planned: "Queued",
  executing: "Running",
  succeeded: "Done",
  failed: "Failed",
  blocked: "Blocked"
};

export function ActiveTasks({ tasks }: { tasks: AgentTask[] | null }) {
  return (
    <section className="hud-panel">
      <span className="hud-label">Active tasks</span>
      {tasks === null ? (
        <p className="faint">Checking…</p>
      ) : tasks.length === 0 ? (
        <p className="faint">Nothing running. Ask something and it appears here.</p>
      ) : (
        <ul className="tasks">
          {tasks.map((task) => (
            <li key={task.id} className={`task task-${task.status}`}>
              <div className="task-head">
                <span className="task-request" title={task.request}>{task.request}</span>
                <span className="task-status">{statusWords[task.status]}</span>
              </div>
              {/* Tools that genuinely ran, in order. This is the closest thing
                  to progress that is actually true — it is a record of work
                  done, not an estimate of work remaining. */}
              {task.toolsUsed.length > 0 ? (
                <div className="task-tools">
                  {task.toolsUsed.map((tool, index) => (
                    <span key={`${tool}-${index}`} className="task-tool">{tool.replace(/_/g, " ")}</span>
                  ))}
                </div>
              ) : null}
              {task.error ? <p className="task-error">{task.error}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type Tile = { href: string; label: string; glyph: string; hint: string };

/**
 * The app's surfaces, as tiles.
 *
 * `onOpen` switches the panel on this screen instead of routing away. Every
 * part of TRHAI used to be its own page, which meant using it took you away
 * from the core, the machine readings and any reply still arriving — the
 * wrong shape for an interface whose whole point is being a live view of one
 * machine. Without the callback these fall back to real links, which is what
 * keeps the old routes usable as bookmarks.
 */
export function ToolsGrid({ tiles, onOpen }: { tiles: Tile[]; onOpen?: (href: string) => void }) {
  return (
    <section className="hud-panel">
      <span className="hud-label">Tools &amp; apps</span>
      <div className="tiles">
        {tiles.map((tile) => (onOpen ? (
          <button key={tile.href} type="button" className="tile" title={tile.hint}
            onClick={() => onOpen(tile.href)}>
            <span className="tile-glyph" aria-hidden="true">{tile.glyph}</span>
            <span className="tile-label">{tile.label}</span>
          </button>
        ) : (
          <Link key={tile.href} href={tile.href} className="tile" title={tile.hint}>
            <span className="tile-glyph" aria-hidden="true">{tile.glyph}</span>
            <span className="tile-label">{tile.label}</span>
          </Link>
        )))}
      </div>
    </section>
  );
}

/**
 * Connected services.
 *
 * Empty, and that is the finding rather than a gap. Everything this build
 * does runs against this machine's own storage and a local model, so there is
 * no account to connect and no key to paste in. Stating that is worth a panel;
 * drawing five logos for services that are not wired to anything would not be.
 */
export function ConnectedServices({ services }: { services: string[] }) {
  return (
    <section className="hud-panel">
      <span className="hud-label">Connected services</span>
      {services.length === 0 ? (
        <p className="faint services-none">
          None. Nothing leaves this machine — no accounts, no API keys, nothing to sign into.
        </p>
      ) : (
        <div className="tiles">
          {services.map((service) => (
            <span key={service} className="tile">{service}</span>
          ))}
        </div>
      )}
    </section>
  );
}

export function MemoryStatus({
  entries, pinned, documents, workspaceBytes, workspaceFiles
}: {
  entries: number | null;
  pinned: number | null;
  documents: number | null;
  workspaceBytes: number | null;
  workspaceFiles: number | null;
}) {
  // The reference shows "87% · 13.2 GB / 15.0 GB", a memory bar filling up.
  // There is no such quota: memories are small text records with no ceiling,
  // so a percentage would need a denominator invented to produce it. The
  // counts are the real quantity, and the workspace has a real size.
  const kb = workspaceBytes === null ? null : (workspaceBytes / 1024).toFixed(0);

  return (
    <section className="hud-panel">
      <span className="hud-label">Memory &amp; storage</span>
      <dl className="hud-readouts">
        <div><dt>Memories</dt><dd>{entries === null ? "—" : entries}</dd></div>
        <div><dt>Pinned</dt><dd>{pinned === null ? "—" : pinned}</dd></div>
        <div><dt>Documents</dt><dd>{documents === null ? "—" : documents}</dd></div>
        <div>
          <dt>Workspace</dt>
          <dd>{workspaceFiles === null ? "—" : `${workspaceFiles} files · ${kb} KB`}</dd>
        </div>
      </dl>
      <Link href="/memory" className="hud-more">View memory</Link>
    </section>
  );
}

export function PersonalityCard({
  name, traits, focus, agentName
}: {
  name: string;
  traits: string[];
  focus: string | null;
  agentName: string | null;
}) {
  return (
    <section className="hud-panel">
      <span className="hud-label">Personality</span>
      <div className="persona">
        <b className="persona-name">{name}</b>
        {/* Real traits from the chosen personality, not a fixed
            "Adaptive · Proactive · Loyal" printed under every mode. */}
        <span className="persona-traits">{traits.join(" · ")}</span>
        {focus ? <p className="faint persona-focus">{focus}</p> : null}
        {agentName ? <span className="faint persona-agent">Agent: {agentName}</span> : null}
      </div>
      <Link href="/settings" className="hud-more">Change personality</Link>
    </section>
  );
}
