"use client";

import { ViewFrame } from "../ui/ViewFrame";
import { Trend } from "../ui/Trend";
import { useSystem, formatRate } from "../state/system";
import { useHealth } from "../state/health";
import { normalisedToPeak } from "../../lib/telemetryHistory";
import { apiBaseUrl } from "../../lib/api";
import "../home/home.css";
import "./views.css";

export function NetworkView() {
  const { telemetry, history, online } = useSystem();
  const { rows } = useHealth();
  const network = telemetry?.network;
  return (
    <ViewFrame id="network">
      <div className="os-grid os-split">
        <section className="os-panel">
          <header className="os-panel-head"><h3 className="os-panel-title">Throughput</h3></header>
          <div className="os-panel-body os-readings">
            <div className="os-big-reading os-mono">{network ? formatRate(network.receivedBytesPerSecond, network.sentBytesPerSecond) : "—"}</div>
            <Trend values={normalisedToPeak(history.network)} height={90} tone="warn" label="Network throughput" />
            <p className="os-faint os-small">Shown against its own peak over the last two minutes; network rates have no natural maximum.</p>
          </div>
        </section>
        <section className="os-panel">
          <header className="os-panel-head"><h3 className="os-panel-title">Local services</h3></header>
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
            <dl className="os-kv">
              <div><dt>Local API</dt><dd className="os-mono">{apiBaseUrl.replace(/^https?:\/\//, "")} · {online === null ? "checking" : online ? "answering" : "not answering"}</dd></div>
              <div><dt>Cloud services in use</dt><dd className="os-mono">{telemetry?.cloud.services.length ?? 0}</dd></div>
            </dl>
            <p className="os-faint os-small">{telemetry?.cloud.detail || "Nothing leaves this machine except web pages TRH AI is asked to read."}</p>
          </div>
        </section>
      </div>
    </ViewFrame>
  );
}
