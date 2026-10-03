"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/api";
import { normalisedToPeak } from "../../lib/telemetryHistory";
import { reachWords, visibleAddresses, type Listening, type NetworkAccess } from "../../lib/systemMonitor";
import { Icon } from "../ui/Icon";
import { Trend } from "../ui/Trend";
import { ViewFrame } from "../ui/ViewFrame";
import { useNotify } from "../state/notify";
import { formatBytesPerSecond, useSystem } from "../state/system";
import "../home/home.css";
import "./views.css";

// The network as TRH AI sees it: what is moving now, this PC's addresses,
// what TRH AI listens on and who can reach it, the local services it runs on,
// the apps it has running - and, when asked, one measured check that the
// internet answers. Then a plain account of what ever leaves this PC.

type NetworkInfo = {
  interfaces: Array<{ name: string; address: string; family: "IPv4" | "IPv6"; internal: boolean }>;
  service: Listening;
  access: NetworkAccess;
  engine: { baseUrl: string; reachable: boolean };
  apps: Array<{ project: string; port: number; url: string }>;
};

type InternetCheck = { reachable: boolean; latencyMs: number | null; target: string; status: number | null; at: Date };

/**
 * Whether other devices are let in, and how that changes. Kept out, it says
 * how to let them in; let in, it shows the key each must send - hidden until
 * asked for, since this page may be on a screen others can see.
 */
function AccessNote({ access }: { access: NetworkAccess }) {
  const { notify } = useNotify();
  const [shown, setShown] = useState(false);
  if (!access.otherDevices) {
    return (
      <p className="os-faint os-small">
        Other devices are kept out. To let them in, add <span className="os-mono">ASCEND_NETWORK_ACCESS=on</span> to the .env file in
        the TRH AI folder and restart TRH AI; each device will then need the access key shown here.
      </p>
    );
  }
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      notify({ level: "success", title: "Access key copied", body: `Another device sends it in the ${access.header} header.`, source: "NETWORK" });
    } catch {
      notify({ level: "error", title: "Could not copy", body: "The clipboard is not available here.", source: "NETWORK" });
    }
  };
  return (
    <div className="os-stack">
      <ul className="os-services">
        <li className="os-access-row">
          <span className={`os-dot ${access.key ? "accent" : "danger"}`} aria-hidden="true" />
          <span>Access key</span>
          <span className="os-mono os-access-key">{access.key ? (shown ? access.key : "•".repeat(12)) : "none could be read"}</span>
        </li>
      </ul>
      {access.key ? (
        <div className="os-view-actions">
          <button type="button" className="os-btn os-btn-sm" aria-pressed={shown} onClick={() => setShown(!shown)}>
            <Icon name={shown ? "eyeOff" : "eye"} size={14} />{shown ? "Hide" : "Show"}
          </button>
          <button type="button" className="os-btn os-btn-sm" onClick={() => void copy(access.key ?? "")}><Icon name="copy" size={14} />Copy</button>
        </div>
      ) : null}
      <p className="os-faint os-small">
        {access.key ? `Another device sends the key in the ${access.header} header; this PC never needs it. ` : "Without it, no other device can connect. "}
        To keep other devices out again, remove ASCEND_NETWORK_ACCESS from the .env file and restart TRH AI.
      </p>
    </div>
  );
}

export function NetworkView() {
  const { telemetry, history } = useSystem();
  const [info, setInfo] = useState<NetworkInfo | null>(null);
  const [allAddresses, setAllAddresses] = useState(false);
  const [checking, setChecking] = useState(false);
  const [internet, setInternet] = useState<InternetCheck | null>(null);

  const load = useCallback(async () => {
    const result = await apiGet<NetworkInfo>("/v1/network");
    if (result.ok) setInfo(result.data);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its request returns
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const check = async () => {
    setChecking(true);
    const result = await apiPost<Omit<InternetCheck, "at">>("/v1/network/check", {});
    setChecking(false);
    setInternet(result.ok ? { ...result.data, at: new Date() } : { reachable: false, latencyMs: null, target: "", status: null, at: new Date() });
  };

  const network = telemetry?.network;
  const reach = reachWords(info?.service ?? null);
  const addresses = info ? visibleAddresses(info.interfaces, allAddresses) : [];
  const pageOrigin = typeof window === "undefined" ? "" : window.location.host;

  return (
    <ViewFrame id="network" actions={internet ? (
      <span className={`os-chip ${internet.reachable ? "ok" : "danger"}`}>{internet.reachable ? `Internet · ${internet.latencyMs} ms` : "Internet not answering"}</span>
    ) : null}>
      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          <section className="os-panel" aria-label="Throughput">
            <header className="os-panel-head">
              <h3 className="os-panel-title">Throughput</h3>
              {network?.unavailable ? <span className="os-faint os-small">{network.unavailable}</span> : null}
            </header>
            <div className="os-panel-body os-stack">
              <div className="os-net-rates">
                <div><span className="os-label">Down</span><strong className="os-mono">{network?.receivedBytesPerSecond != null ? formatBytesPerSecond(network.receivedBytesPerSecond) : "—"}</strong></div>
                <div><span className="os-label">Up</span><strong className="os-mono">{network?.sentBytesPerSecond != null ? formatBytesPerSecond(network.sentBytesPerSecond) : "—"}</strong></div>
              </div>
              <Trend values={normalisedToPeak(history.network)} height={90} tone="warn" label="Network throughput, the last two minutes" />
              <p className="os-faint os-small">Against its own peak over the last two minutes - network rates have no natural maximum.</p>
            </div>
          </section>

          <section className="os-panel" aria-label="TRH AI on the network">
            <header className="os-panel-head"><h3 className="os-panel-title">TRH AI on the network</h3></header>
            <div className="os-panel-body os-stack">
              <p className={`os-small ${reach.fromNetwork ? "os-warn-text" : "os-faint"}`}>{reach.text}</p>
              {info?.access ? <AccessNote access={info.access} /> : null}
              <ul className="os-services">
                <li><span className="os-dot ok" aria-hidden="true" /><span>This page</span><span className="os-mono os-faint">{pageOrigin}</span></li>
                <li><span className={`os-dot ${info?.service ? "ok" : ""}`} aria-hidden="true" /><span>TRH AI&rsquo;s service</span><span className="os-mono os-faint">port {info?.service?.port ?? "—"}</span></li>
                <li>
                  <span className={`os-dot ${info ? (info.engine.reachable ? "ok" : "danger") : ""}`} aria-hidden="true" />
                  <span>The model engine (llama.cpp)</span>
                  <span className="os-mono os-faint">{info?.engine.baseUrl.replace(/^https?:\/\//, "") ?? "—"}{info && !info.engine.reachable ? " · not answering" : ""}</span>
                </li>
                {info?.apps.map((app) => (
                  <li key={app.project}>
                    <span className="os-dot ok live" aria-hidden="true" />
                    <span>{app.project} <span className="os-faint">(an app TRH AI built)</span></span>
                    <a className="os-mono" href={app.url} target="_blank" rel="noreferrer">port {app.port}</a>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="os-panel" aria-label="What leaves this PC">
            <header className="os-panel-head"><h3 className="os-panel-title">What leaves this PC</h3></header>
            <div className="os-panel-body">
              <ul className="os-leaves">
                <li><strong>Replies</strong> - never. Every reply is written by the model on this PC{telemetry && telemetry.cloud.services.length === 0 ? "; no cloud AI is in use." : "."}</li>
                <li><strong>Web pages and searches</strong> - only when TRH AI is asked to read or look something up, or you use the Browser. Searches go to DuckDuckGo.</li>
                <li><strong>Email</strong> - only one you approve, through your own account or your mail app.</li>
                <li><strong>Texts</strong> - only one you approve, from your own phone through Phone Link.</li>
              </ul>
            </div>
          </section>
        </div>

        <aside className="os-tasks-side">
          <section className="os-panel" aria-label="Internet">
            <header className="os-panel-head"><h3 className="os-panel-title">Internet</h3></header>
            <div className="os-panel-body os-stack">
              {internet ? (
                <p className={`os-small ${internet.reachable ? "" : "os-warn-text"}`}>
                  {internet.reachable ? `Answered in ${internet.latencyMs} ms` : "Nothing answered"} · checked {internet.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
                </p>
              ) : <p className="os-faint os-small">Checked only when you ask - one request to the search engine TRH AI uses.</p>}
              <button type="button" className="os-btn os-btn-sm" disabled={checking} onClick={() => void check()}><Icon name="refresh" size={14} />{checking ? "Checking…" : "Check now"}</button>
            </div>
          </section>
          <section className="os-panel" aria-label="This PC's addresses">
            <header className="os-panel-head">
              <h3 className="os-panel-title">This PC</h3>
              <button type="button" className={`os-btn os-btn-sm os-btn-ghost${allAddresses ? " on" : ""}`} aria-pressed={allAddresses} onClick={() => setAllAddresses(!allAddresses)}>
                {allAddresses ? "Fewer" : "All addresses"}
              </button>
            </header>
            <div className="os-panel-body">
              {info === null ? <p className="os-faint">Reading…</p> : addresses.length === 0 ? <p className="os-faint os-small">No network addresses other than this PC&rsquo;s own.</p> : (
                <ul className="os-addresses">
                  {addresses.map((entry) => (
                    <li key={`${entry.name}-${entry.address}`}>
                      <span className="os-mono">{entry.address}</span>
                      <span className="os-faint os-small">{entry.name} · {entry.family}{entry.internal ? " · this PC only" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </aside>
      </div>
    </ViewFrame>
  );
}
