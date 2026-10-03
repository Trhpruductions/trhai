"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { formatBytes } from "../../lib/files";
import { idleWords, reachWords, windowWords, type LoadedModel, type Listening } from "../../lib/systemMonitor";
import { Icon } from "../ui/Icon";
import { Trend, type TrendTone } from "../ui/Trend";
import { ViewFrame } from "../ui/ViewFrame";
import { useHealth } from "../state/health";
import { useNotify } from "../state/notify";
import { formatUptime, percent, useSystem, type Reading } from "../state/system";
import "../home/home.css";
import "./views.css";

// This machine, measured live, and the parts of TRH AI that run on it: every
// reading is taken when it is shown, and one that cannot be taken says why
// instead of showing a number. The model TRH AI's engine is holding in memory
// is listed with the window it was given - and can be let go, to give a game
// or a stream its graphics memory back.

type Runtime = {
  service: { pid: number; node: string; startedAt: string; uptimeSeconds: number; rssBytes: number; heapUsedBytes: number; listening: Listening };
  engine: {
    baseUrl: string; reachable: boolean; version: string | null; loaded: LoadedModel[];
    installed: Array<{ name: string; sizeBytes: number }>;
    idleUnloadSeconds: number;
    /** Why the engine is not running, when the service knows. */
    reason: string | null;
  };
  stores: { failing: Array<{ store: string; error: string; at: string }>; locked: string[] };
};

/** One resource: its reading now, and its last two minutes - or, for one with no history kept, how full it is. */
function ResourceCard({ title, reading, values, tone, facts }: {
  title: string; reading: Reading | null | undefined; values: Array<number | null> | null; tone: TrendTone; facts: Array<string | null | undefined>;
}) {
  const unavailable = reading?.unavailable ?? null;
  const fraction = reading?.fraction ?? null;
  return (
    <section className="os-panel os-resource" aria-label={title}>
      <header className="os-panel-head">
        <h3 className="os-panel-title">{title}</h3>
        <span className="os-resource-value os-mono">{reading ? (unavailable ? "—" : percent(reading.fraction)) : "…"}</span>
      </header>
      <div className="os-panel-body os-stack">
        {values ? <Trend values={values} height={56} tone={tone} label={`${title}, the last two minutes`} />
          : fraction !== null && !unavailable ? (
            <div className={`os-meter os-resource-meter${fraction > 0.9 ? " danger" : fraction > 0.75 ? " warn" : ""}`} role="meter"
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} aria-label={`${title} used`}>
              <span style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          ) : null}
        {unavailable ? <p className="os-faint os-small">{unavailable}</p> : null}
        <ul className="os-resource-facts">
          {[reading?.detail, ...facts].filter((fact): fact is string => Boolean(fact)).map((fact) => <li key={fact}>{fact}</li>)}
        </ul>
      </div>
    </section>
  );
}

export function SystemView() {
  const { telemetry, history, modelName } = useSystem();
  const { rows, health } = useHealth();
  const { notify } = useNotify();
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [unloading, setUnloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await apiGet<Runtime>("/v1/system/runtime");
    if (result.ok) setRuntime(result.data);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its request returns
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const unload = async (name: string) => {
    setUnloading(name);
    const result = await apiPost<{ unloaded: string }>("/v1/system/models/unload", { name });
    setUnloading(null);
    if (result.ok) notify({ level: "success", title: `${name} let go`, body: "Its memory is free. The next request that needs it loads it again.", source: "SYSTEM" });
    else notify({ level: "error", title: `Could not unload ${name}`, body: result.reason, source: "SYSTEM" });
    void load();
  };

  const gpu = telemetry?.gpu;
  const reach = reachWords(runtime?.service.listening ?? null);

  return (
    <ViewFrame
      id="system"
      actions={(
        <>
          {telemetry ? <span className="os-chip">Up {formatUptime(telemetry.uptimeSeconds)}</span> : null}
          <span className={`os-chip ${modelName ? "ok" : "warn"}`}>{modelName ? `Model: ${modelName}` : "No model answering"}</span>
        </>
      )}
    >
      <div className="os-resources">
        <ResourceCard title="Processor" reading={telemetry?.cpu} values={history.cpu} tone="accent"
          facts={[telemetry ? `${telemetry.cpu.cores} cores${telemetry.cpu.speedMhz ? ` · ${(telemetry.cpu.speedMhz / 1000).toFixed(2)} GHz` : ""}` : null, telemetry?.cpu.model]} />
        <ResourceCard title="Memory" reading={telemetry?.memory} values={history.memory} tone="violet" facts={[]} />
        <ResourceCard title="Graphics" reading={gpu} values={history.gpu} tone="ok"
          facts={[
            gpu?.name,
            gpu?.vram && !gpu.vram.unavailable ? `Video memory ${percent(gpu.vram.fraction)} · ${gpu.vram.detail}` : null,
            [gpu?.temperatureC != null ? `${gpu.temperatureC} °C` : null, gpu?.clockMhz != null ? `${gpu.clockMhz} MHz` : null, gpu?.powerWatts != null ? `${gpu.powerWatts} W` : null]
              .filter(Boolean).join(" · ") || null
          ]} />
        <ResourceCard title="Disk" reading={telemetry?.disk} values={null} tone="warn" facts={[]} />
      </div>

      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          <section className="os-panel" aria-label="Models in memory">
            <header className="os-panel-head">
              <h3 className="os-panel-title">Models in memory</h3>
              {runtime ? (
                <span className={`os-chip ${runtime.engine.reachable ? "ok" : "danger"}`}>
                  {runtime.engine.reachable ? `llama.cpp${runtime.engine.version ? ` ${runtime.engine.version}` : ""}` : "Model engine not answering"}
                </span>
              ) : null}
            </header>
            <div className="os-panel-body os-stack">
              {runtime === null ? <p className="os-faint">Asking the model engine…</p>
                : !runtime.engine.reachable ? <p className="os-faint os-small">{runtime.engine.reason ?? `Nothing answered at ${runtime.engine.baseUrl}. Start TRH AI again, and it can think again.`}</p>
                  : runtime.engine.loaded.length === 0 ? <p className="os-faint os-small">None. A model loads when TRH AI next needs one, and is {idleWords(runtime.engine.idleUnloadSeconds)}.</p>
                    : (
                      <ul className="os-models">
                        {runtime.engine.loaded.map((model) => (
                          <li key={model.name}>
                            <div className="os-models-text">
                              <strong className="os-mono">{model.name}</strong>
                              <span className="os-faint os-small">{[formatBytes(model.sizeBytes), windowWords(model), idleWords(runtime.engine.idleUnloadSeconds)].filter(Boolean).join(" · ")}</span>
                            </div>
                            <button type="button" className="os-btn os-btn-sm" disabled={unloading !== null} onClick={() => void unload(model.name)}>
                              <Icon name="stop" size={13} />{unloading === model.name ? "Letting go…" : "Unload"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
              {runtime?.engine.installed.length ? (
                <details className="os-models-installed">
                  <summary>Installed · {runtime.engine.installed.length}</summary>
                  <ul>
                    {runtime.engine.installed.map((model) => (
                      <li key={model.name}><span className="os-mono">{model.name}</span><span className="os-faint">{formatBytes(model.sizeBytes)}</span></li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          </section>

          <section className="os-panel" aria-label="TRH AI's service">
            <header className="os-panel-head"><h3 className="os-panel-title">TRH AI&rsquo;s service</h3></header>
            <div className="os-panel-body os-stack">
              {runtime === null ? <p className="os-faint">Reading…</p> : (
                <>
                  <dl className="os-kv">
                    <div><dt>Running for</dt><dd className="os-mono">{formatUptime(runtime.service.uptimeSeconds)}</dd></div>
                    <div><dt>Memory</dt><dd className="os-mono">{formatBytes(runtime.service.rssBytes)}</dd></div>
                    <div><dt>Node</dt><dd className="os-mono">{runtime.service.node}</dd></div>
                    <div><dt>Process</dt><dd className="os-mono">{runtime.service.pid}</dd></div>
                  </dl>
                  <p className={`os-small ${reach.fromNetwork ? "os-warn-text" : "os-faint"}`}>{reach.text}</p>
                  {runtime.stores.failing.length ? (
                    <p className="os-task-alert" role="alert">
                      <Icon name="alert" size={14} />
                      Not saving: {runtime.stores.failing.map((entry) => `${entry.store} (${entry.error})`).join("; ")}. Changes there would be lost on a restart.
                    </p>
                  ) : <p className="os-faint os-small">Every store is saving normally.</p>}
                  {runtime.stores.locked.length ? <p className="os-task-alert"><Icon name="alert" size={14} />Locked and unreadable: {runtime.stores.locked.join(", ")}.</p> : null}
                </>
              )}
            </div>
          </section>
        </div>
        <aside className="os-tasks-side">
          <section className="os-panel" aria-label="Health checks">
            <header className="os-panel-head">
              <h3 className="os-panel-title">Health checks</h3>
              {health ? <span className={`os-chip ${health.passed === health.total ? "ok" : "warn"}`}>{health.passed} of {health.total} passing</span> : null}
            </header>
            <div className="os-panel-body">
              <ul className="os-health-rows">
                {rows.map((row) => (
                  <li key={row.label}>
                    <span className={`os-dot ${row.ok === null ? "" : row.ok ? "ok" : "warn"}`} aria-hidden="true" />
                    <span>{row.label}</span>
                    <span className="os-faint os-mono">{row.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </aside>
      </div>
    </ViewFrame>
  );
}
