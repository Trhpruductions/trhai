import { useEffect, useState } from "react";
import { webEnv } from "../env";
import { clampPercent } from "../dashboardStatus";
import "./statusbar.css";

// The live strip.
//
// A HUD that shows nothing is just a dark rectangle. This is the part of the
// interface that is always moving, so the app reads as running rather than
// waiting — but every figure on it is measured, not decorative. A reading with
// no source shows a dash, because a plausible number is worse than an obvious
// gap.

type Readings = {
  cpu: number | null;
  memory: number | null;
  storage: number | null;
  apiMs: number | null;
  model: string | null;
  online: boolean;
};

const empty: Readings = { cpu: null, memory: null, storage: null, apiMs: null, model: null, online: false };

/**
 * Host readings, or nothing.
 *
 * Only the desktop bridge can measure this machine, so only it produces these.
 * A browser tab can report its own JS heap and storage quota, and an earlier
 * version of this strip showed those under CPU / MEM / DSK — which reads as
 * your computer's memory and is not. A number labelled as something it is not
 * measuring is worse than no number, so in a browser the gauges are absent
 * rather than filled with a proxy.
 */
async function readHost(): Promise<Pick<Readings, "cpu" | "memory" | "storage">> {
  const bridge = window.ascendDesktop?.getSystemTelemetry;
  if (!bridge) return { cpu: null, memory: null, storage: null };

  const result = await bridge();
  if (!result?.ok) return { cpu: null, memory: null, storage: null };

  return {
    cpu: result.cpuPercent ?? null,
    memory: result.memoryPercent ?? null,
    storage: result.storagePercent ?? null
  };
}

export function StatusBar() {
  const [readings, setReadings] = useState<Readings>(empty);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;

    async function sample() {
      const host = await readHost();

      // The API round trip is timed rather than reported, so the number means
      // what the user experiences rather than what the server claims.
      let apiMs: number | null = null;
      let model: string | null = null;
      let online = false;

      const startedAt = performance.now();
      try {
        const response = await fetch(`${webEnv.apiBaseUrl}/v1/assist/model`);
        apiMs = Math.round(performance.now() - startedAt);
        online = response.ok;
        if (response.ok) {
          const payload = await response.json();
          model = payload?.data?.model ?? null;
        }
      } catch {
        online = false;
      }

      if (!cancelled) setReadings({ ...host, apiMs, model, online });
    }

    void sample();
    const sampler = window.setInterval(sample, 4000);
    const ticker = window.setInterval(() => setClock(new Date()), 1000);

    return () => { cancelled = true; window.clearInterval(sampler); window.clearInterval(ticker); };
  }, []);

  const gauges = ([
    { label: "CPU", value: readings.cpu },
    { label: "MEM", value: readings.memory },
    { label: "DSK", value: readings.storage }
  ] as Array<{ label: string; value: number | null }>)
    .filter((gauge): gauge is { label: string; value: number } => gauge.value !== null);

  return (
    <footer className="statusbar" aria-label="System status">
      <span className={`sb-dot${readings.online ? " live" : ""}`} aria-hidden="true" />
      <span className="sb-state">{readings.online ? "ONLINE" : "OFFLINE"}</span>

      {/* Host gauges appear only when there is a host to read. In a browser
          they are absent rather than zeroed, because an empty gauge invites the
          reader to believe the machine is idle. */}
      {gauges.length > 0 ? (
        <>
          <span className="sb-sep" aria-hidden="true" />
          {gauges.map((gauge) => (
            <span key={gauge.label} className="sb-gauge">
              <span className="sb-gauge-label">{gauge.label}</span>
              <span className="sb-bar"><i style={{ width: `${clampPercent(gauge.value)}%` }} /></span>
              <span className="sb-gauge-value mono">{clampPercent(gauge.value)}%</span>
            </span>
          ))}
        </>
      ) : null}

      <span className="sb-sep" aria-hidden="true" />

      <span className="sb-item mono" title="Round trip to the local API">
        API {readings.apiMs === null ? "—" : `${readings.apiMs}ms`}
      </span>

      <span className={`sb-item sb-model${readings.model ? " live" : ""}`}
        title={readings.model ? `Answers can come from ${readings.model}` : "No local model — answers come from your notes and documents only"}>
        {readings.model ? readings.model.replace(/:latest$/, "") : "no model"}
      </span>

      <span className="grow" />

      <span className="sb-item mono sb-clock">
        {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
    </footer>
  );
}
