"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import "./rings.css";

// CPU, memory and GPU, read from this machine.
//
// The readings come from the local API process rather than the browser, which
// is the only reason they can exist at all: a page has no access to host
// hardware, and every "system monitor" that runs purely in a tab is either
// showing the tab's own numbers or making them up. The API is a Node process
// on this machine, so os.cpus() and nvidia-smi are real readings of the real
// machine.
//
// A sensor that cannot be read shows a dash and says why, rather than a
// number. That matters more here than anywhere else on the dashboard: a ring
// at 40% is indistinguishable from a real one by looking, so an invented
// value would not read as missing data — it would read as fact.

type Reading = { fraction: number | null; detail: string; unavailable: string | null };

type Telemetry = {
  cpu: Reading & { model: string; cores: number };
  memory: Reading;
  gpu: Reading & { name: string | null };
  cloud: { services: string[]; detail: string };
  uptimeSeconds: number;
};

/** How often the rings re-read. Frequent enough to track, not a busy loop. */
const pollMs = 4000;

function uptimeText(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * One ring.
 *
 * Drawn as an SVG arc rather than a CSS conic gradient so the same markup
 * carries the value to assistive technology: the ring is the number, and a
 * screen reader gets the number rather than a decorative circle.
 */
function Ring({ label, reading, caption }: { label: string; reading: Reading; caption: string }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const known = reading.fraction !== null;
  const filled = known ? circumference * reading.fraction! : 0;
  const percent = known ? Math.round(reading.fraction! * 100) : null;

  // Colour tracks load rather than decorating: a ring near its limit should
  // be visibly different from one at rest without having to read the number.
  const tone = !known ? "unknown" : reading.fraction! >= 0.9 ? "danger" : reading.fraction! >= 0.7 ? "warn" : "ok";

  return (
    <div className={`sysring sysring-${tone}`}>
      <div
        className="sysring-dial"
        role="img"
        aria-label={known ? `${label}: ${percent}% — ${reading.detail}` : `${label}: no reading — ${reading.unavailable}`}
        title={known ? reading.detail : (reading.unavailable ?? "")}
      >
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="sysring-track" cx="32" cy="32" r={radius} />
          {known ? (
            <circle
              className="sysring-fill"
              cx="32" cy="32" r={radius}
              strokeDasharray={`${filled} ${circumference - filled}`}
              // Starts at the top and fills clockwise, the way a dial reads.
              transform="rotate(-90 32 32)"
            />
          ) : null}
        </svg>
        <span className="sysring-value">{known ? `${percent}%` : "—"}</span>
      </div>
      <span className="sysring-label">{label}</span>
      {/* The reason a sensor is unreadable is shown, not just implied by the
          dash. "No NVIDIA GPU detected" is a useful fact about the machine;
          a bare dash is a puzzle. */}
      <span className="sysring-caption" title={caption}>
        {known ? caption : (reading.unavailable ?? "No reading")}
      </span>
    </div>
  );
}

export function SystemRings() {
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      const result = await apiGet<Telemetry>("/v1/system-telemetry");
      if (cancelled) return;
      setReachable(result.ok);
      // A failed read keeps the last real numbers on screen rather than
      // blanking them; the panel says the service is unreachable instead, so
      // a momentary blip does not look like the machine going quiet.
      if (result.ok) setTelemetry(result.data);
    }

    void read();
    const poller = window.setInterval(() => void read(), pollMs);
    return () => { cancelled = true; window.clearInterval(poller); };
  }, []);

  if (!telemetry) {
    return (
      <section className="hud-panel">
        <span className="hud-label">This machine</span>
        <p className="faint">
          {reachable === false ? "The local API is not responding." : "Reading this machine…"}
        </p>
      </section>
    );
  }

  return (
    <section className="hud-panel">
      <div className="sysrings-head">
        <span className="hud-label">This machine</span>
        {reachable === false ? <span className="sysrings-stale">stale</span> : null}
      </div>

      <div className="sysrings">
        <Ring label="CPU" reading={telemetry.cpu} caption={`${telemetry.cpu.cores} cores`} />
        <Ring label="Memory" reading={telemetry.memory} caption={telemetry.memory.detail} />
        <Ring
          label="GPU"
          reading={telemetry.gpu}
          caption={telemetry.gpu.name?.replace(/^NVIDIA\s+/, "") ?? ""}
        />
      </div>

      <dl className="hud-readouts">
        <div>
          <dt>Processor</dt>
          <dd className="sysrings-model" title={telemetry.cpu.model}>{telemetry.cpu.model}</dd>
        </div>
        <div><dt>Uptime</dt><dd>{uptimeText(telemetry.uptimeSeconds)}</dd></div>
        {/* Not a blank card. "No cloud services" is the honest reading for
            this build, and stating it is the point rather than a gap. */}
        <div>
          <dt>Cloud</dt>
          <dd className="ok" title={telemetry.cloud.detail}>
            {telemetry.cloud.services.length === 0 ? "none — all local" : telemetry.cloud.services.join(", ")}
          </dd>
        </div>
      </dl>
    </section>
  );
}
