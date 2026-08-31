"use client";

import { gaugeTone } from "./coreVisual";
import "./corepanels.css";

// The panels the reference design calls for: AI CORE STATUS, SYSTEM OVERVIEW,
// RECENT ACTIVITY and TODAY'S OVERVIEW.
//
// The reference also has an ACTIVE MODULES list. That one is not here: the
// eight subsystems it would list are already drawn as chips flanking the core,
// with the same data, so a panel for them made the screen report every
// subsystem twice.
//
// The layout is followed closely. The numbers are not invented to fill it.
//
// Most of what the reference shows turns out to be genuinely available on this
// machine: CORE TEMP is the GPU's real temperature from nvidia-smi, CPU USAGE
// and MEMORY are measured, UPTIME is real, RECENT ACTIVITY is the execution
// log with the timestamps of things that actually happened, and TODAY'S
// OVERVIEW counts real tasks.
//
// Where a reading cannot be taken, the panel says so rather than showing a
// plausible number. A temperature is the sharpest case: it is a physical
// measurement, and a made-up one would be the most convincing fake on the
// screen precisely because nothing about it would look wrong.

export type Reading = {
  fraction: number | null;
  detail: string;
  unavailable: string | null;
};

/** A labelled ring, as the reference draws them down the left. */
function Gauge({ label, reading, sub, higherIsBetter = false }: {
  label: string;
  reading: Reading | null | undefined;
  sub?: string;
  /**
   * Which end of the scale is the good end.
   *
   * Nearly every reading here is a consumption figure, where full is bad — a
   * disk at 95% is a warning. Health is the opposite, and without this it was
   * drawn in danger red precisely when every check was passing: a red ring
   * over the words "all passing". A gauge that colours a good reading as an
   * alarm is worse than no colour at all.
   */
  higherIsBetter?: boolean;
}) {
  const fraction = reading?.fraction;
  const known = fraction !== null && fraction !== undefined;
  const percent = known ? Math.round(fraction * 100) : null;
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const filled = known ? circumference * fraction : 0;
  const tone = gaugeTone(fraction, higherIsBetter);

  return (
    <div className={`gauge-row gauge-${tone}`}>
      <div className="gauge-dial" role="img"
        aria-label={known ? `${label}: ${percent}%` : `${label}: no reading`}>
        <svg viewBox="0 0 56 56" aria-hidden="true">
          <circle className="gauge-track" cx="28" cy="28" r={radius} />
          {known ? (
            <circle className="gauge-fill" cx="28" cy="28" r={radius}
              strokeDasharray={`${filled} ${circumference - filled}`}
              transform="rotate(-90 28 28)" />
          ) : null}
        </svg>
        <span className="gauge-inner">{percent === null ? "—" : `${percent}%`}</span>
      </div>

      <div className="gauge-text">
        <span className="gauge-name">{label}</span>
        <span className="gauge-value">{percent === null ? "—" : `${percent}%`}</span>
        <span className="gauge-sub">{known ? (sub ?? reading?.detail ?? "") : (reading?.unavailable ?? "no reading")}</span>
      </div>
    </div>
  );
}

export function CoreStatus({
  temperatureC, uptimeSeconds, load, clockMhz, cpuModel
}: {
  temperatureC: number | null;
  uptimeSeconds: number | null;
  /** From the real pipeline stage, or "idle" when nothing is running. */
  load: string;
  /** Processor clock. Shown instead of CPU load, which the top strip owns. */
  clockMhz: number | null;
  cpuModel: string | null;
}) {
  const uptime = uptimeSeconds === null ? null : (() => {
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  })();

  return (
    <section className="hud-panel">
      <span className="hud-label">AI core status</span>
      <dl className="core-stats">
        <div>
          <dt>Core temp</dt>
          {/* The GPU's real temperature. Absent on a machine with no NVIDIA
              card, and absent is what it says — a fabricated temperature would
              be the most convincing fake on this screen. */}
          <dd className={temperatureC === null ? "faint" : temperatureC >= 80 ? "danger" : ""}>
            {temperatureC === null ? "not reported" : `${Math.round(temperatureC)}°C`}
          </dd>
        </div>
        {/* Clock, not load. CPU load is in the top strip and was being shown
            here and in the gauge stack as well — three copies of one reading. */}
        <div><dt>Clock</dt><dd>{clockMhz ? `${(clockMhz / 1000).toFixed(1)} GHz` : "—"}</dd></div>
        <div><dt>Uptime</dt><dd>{uptime ?? "—"}</dd></div>
        {/* Spans the row because this one is a phrase, not a number: mid-turn
            it reads "BUILDING · WRITE FILE", which in a half-width cell
            collided with the value beside it. */}
        <div className="wide"><dt>AI load</dt><dd className="load">{load}</dd></div>
      </dl>
      {cpuModel ? <span className="faint core-model" title={cpuModel}>{cpuModel}</span> : null}
    </section>
  );
}

export function SystemGauges({
  vram, disk, network, health
}: {
  vram: Reading | null;
  disk: Reading | null;
  /** Throughput has no honest denominator, so it is a line rather than a ring. */
  network: Reading | null;
  /** How many checks passed, and how many were decided at all. */
  health: { passed: number; total: number } | null;
}) {
  // The reference's fourth ring is "STABILITY", which nothing here measures.
  // Health is the honest equivalent and is a real fraction of real checks, so
  // it takes that place rather than a number chosen to sit near 98%.
  //
  // The detail is the count rather than "all passing". Two reasons, and the
  // second is the better one: "all passing" did not fit the rail and was being
  // ellipsised, and "4/5" says how many checks there are and how many failed,
  // which the words never did.
  const healthReading: Reading | null = health === null || health.total === 0
    ? null
    : {
      fraction: health.passed / health.total,
      detail: `${health.passed}/${health.total}`,
      unavailable: null
    };

  return (
    <section className="hud-panel">
      <span className="hud-label">System overview</span>
      {/* Memory, processor and graphics are not here: the top strip already
          carries all three, and a screen that reports the same reading twice
          is one that can visibly disagree with itself between polls. What is
          left is what the strip has no room for. */}
      {/* Short labels. These no longer share a screen with the top strip's
          wording, and "Video memory" plus its reading plus its percentage did
          not fit a 230px rail — the reading was the part that got cut.

          The gauge shows its own detail rather than the GPU clock, which is
          what it used to carry: a clock speed printed under a memory gauge is
          a real number filed under the wrong heading, which is its own kind of
          wrong even when the figure is right. */}
      <div className="gauges">
        <Gauge label="VRAM" reading={vram} />
        <Gauge label="Disk" reading={disk} />
        <Gauge label="Health" reading={healthReading} higherIsBetter />
      </div>

      {/* Network gets a readout rather than a ring on purpose. A ring needs a
          maximum, and the only candidate is the link's advertised speed, which
          is not what a connection delivers — a 1 Gb/s adapter on a 40 Mb/s line
          would sit at 4% during a flat-out download. The numbers are real; the
          denominator would have been invented. */}
      <div className={`netline${network?.unavailable ? " off" : ""}`}>
        <span className="gauge-name">Network</span>
        <span className="netline-value mono">
          {network?.unavailable ? network.unavailable : (network?.detail || "—")}
        </span>
      </div>
    </section>
  );
}

export type ActivityRow = { id: string; label: string; at: string; status: string };

export function RecentActivity({ rows }: { rows: ActivityRow[] }) {
  return (
    <section className="hud-panel">
      <span className="hud-label">Recent activity</span>
      {rows.length === 0 ? (
        <p className="faint activity-empty">
          Nothing yet. Steps appear here with the time they actually happened.
        </p>
      ) : (
        <ul className="activity">
          {rows.map((row) => (
            <li key={row.id} className={`activity-row activity-${row.status}`}>
              <span className="activity-dot" aria-hidden="true" />
              <span className="activity-label" title={row.label}>{row.label}</span>
              <span className="activity-time mono">
                {new Date(row.at).toLocaleTimeString(undefined, {
                  hour: "2-digit", minute: "2-digit", second: "2-digit"
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
