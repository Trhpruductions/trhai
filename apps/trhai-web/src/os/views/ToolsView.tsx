"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandAccess } from "../../components/CommandAccess";
import { apiGet } from "../../lib/api";
import { whenUsed } from "../../lib/conversationGroups";
import { formatDuration } from "../../lib/taskCenter";
import {
  countByLevel, countTools, filterTools, groupByArea, lastCallWords, levels, toolFilters, usageLine,
  type ToolEntry, type ToolFilter
} from "../../lib/toolCenter";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useSystem } from "../state/system";
import "./views.css";

// Everything TRH AI can do: each tool in plain words, how much it is allowed
// to do and whether it asks first, whether it can run on this PC right now and
// why not, and how often it has run. Read from /v1/tools, which checks what it
// says - the machine-access switch, the vision model, ffmpeg, Piper, Phone
// Link, an email account - rather than describing a tool as ready because it
// exists.

type ToolsData = {
  tools: ToolEntry[];
  model: { available: boolean; name: string | null; reason: string | null };
  machineAccess: { armed: boolean; until: string | null };
};

const readinessTone = { ready: "ok", off: "", "needs-setup": "warn" } as const;
const readinessWords = { ready: "Ready", off: "Off", "needs-setup": "Needs setup" } as const;

/** "just now", "5m ago", "Yesterday". */
function ago(iso: string, now: Date): string {
  const said = whenUsed(iso, now);
  if (said === "now") return "just now";
  return /^\d+[mh]$/.test(said) ? `${said} ago` : said;
}

function ToolCard({ tool, now }: { tool: ToolEntry; now: Date }) {
  const [open, setOpen] = useState(false);
  const level = levels[tool.level];
  const last = lastCallWords(tool.usage);
  const notReady = tool.readiness.state !== "ready";
  return (
    <li className={`os-tool${notReady ? " attention" : ""}${open ? " open" : ""}`}>
      <button type="button" className="os-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`os-dot ${readinessTone[tool.readiness.state]}`} aria-hidden="true" />
        <span className="os-tool-names">
          <strong>{tool.title}</strong>
          <span className="os-mono os-faint">{tool.name}</span>
        </span>
        <Icon name="chevronDown" size={15} className="os-hist-chevron" />
      </button>
      <p className="os-tool-summary">{tool.summary}</p>
      <div className="os-tool-chips">
        <span className={`os-chip ${level.tone}`} title={level.meaning}>{level.label}</span>
        {tool.asksFirst ? <span className="os-chip violet">Asks first</span> : null}
        {notReady ? <span className={`os-chip ${readinessTone[tool.readiness.state]}`}>{readinessWords[tool.readiness.state]}</span> : null}
      </div>
      {tool.readiness.note ? <p className={`os-tool-note${notReady ? " warn" : ""}`}>{tool.readiness.note}</p> : null}
      <p className="os-tool-usage" title={tool.usage.lastUsedAt ? new Date(tool.usage.lastUsedAt).toLocaleString() : undefined}>
        {usageLine(tool.usage, (iso) => ago(iso, now))}
      </p>
      {open ? (
        <div className="os-tool-detail">
          <dl className="os-tool-facts">
            <div><dt>Permission</dt><dd>{level.label}: {level.meaning}</dd></div>
            <div><dt>Status</dt><dd>{readinessWords[tool.readiness.state]}{tool.readiness.note ? ` - ${tool.readiness.note}` : ""}</dd></div>
            {last ? <div><dt>Last call</dt><dd>{last}{tool.usage.lastDurationMs !== null ? `, in ${formatDuration(tool.usage.lastDurationMs)}` : ""}</dd></div> : null}
            {tool.usage.uses > 0 ? <div><dt>Without a result</dt><dd>{tool.usage.noResult} of {tool.usage.uses} - nothing matched, or it was refused or failed</dd></div> : null}
          </dl>
          <div className="os-tool-instructions">
            <span className="os-label">What TRH AI is told about it</span>
            <p>{tool.instructions}</p>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function ToolsView() {
  const { buildVersion } = useSystem();
  const [data, setData] = useState<ToolsData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const result = await apiGet<ToolsData>("/v1/tools");
    if (!result.ok) {
      setFailed(result.reason);
      return;
    }
    setFailed(null);
    setData(result.data);
    setNow(new Date());
  }, []);

  // Read on arrival and every 15 seconds while open: counts move as tools run.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() sets state only after its request returns
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const tools = useMemo(() => data?.tools ?? [], [data]);
  const counts = useMemo(() => countTools(tools), [tools]);
  const groups = useMemo(() => groupByArea(filterTools(tools, query, filter)), [tools, query, filter]);
  const perLevel = useMemo(() => countByLevel(tools), [tools]);

  return (
    <ViewFrame
      id="tools"
      actions={(
        <>
          <span className="os-chip accent">{data ? `${tools.length} tools` : "Loading…"}</span>
          <span className="os-chip" title="Every tool ships with TRH AI and updates with it">Built in · v{buildVersion}</span>
          {data ? (
            data.model.available
              ? <span className="os-chip ok">Model: {data.model.name}</span>
              : <span className="os-chip danger">Model not answering</span>
          ) : null}
        </>
      )}
    >
      {data && !data.model.available ? (
        <p className="os-task-alert" role="alert">
          <Icon name="alert" size={14} />
          The local model is not answering, so TRH AI cannot use any tool right now.{data.model.reason ? ` ${data.model.reason}` : ""}
        </p>
      ) : null}

      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          <div className="os-tasks-toolbar">
            <label className="os-convos-search os-mem-search">
              <Icon name="search" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
                placeholder="Search tools" aria-label="Search tools" />
            </label>
            <div className="os-choice" role="radiogroup" aria-label="Show">
              {toolFilters.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={filter === option.id} className={filter === option.id ? "on" : ""}
                  onClick={() => setFilter(option.id)}>
                  {option.label}<span className="os-faint"> {counts[option.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {!data ? (
            <div className="os-panel"><div className="os-empty"><strong>{failed ? "Could not read the tools" : "Reading the tools…"}</strong>{failed ? <p>{failed}</p> : null}</div></div>
          ) : groups.length === 0 ? (
            <div className="os-panel">
              <div className="os-empty">
                <strong>No tool matches</strong>
                <p>{filter === "attention" ? "Every tool can run right now." : filter === "used" ? "Nothing has run yet. Tools are counted as TRH AI uses them." : "Try fewer words."}</p>
              </div>
            </div>
          ) : groups.map((group) => (
            <section key={group.area} className="os-panel" aria-label={group.area}>
              <header className="os-panel-head">
                <h3 className="os-panel-title">{group.area}</h3>
                <span className="os-faint os-small">{group.tools.length}</span>
              </header>
              <div className="os-panel-body">
                <ul className="os-tool-list">
                  {group.tools.map((tool) => <ToolCard key={tool.name} tool={tool} now={now} />)}
                </ul>
              </div>
            </section>
          ))}
        </div>

        <aside className="os-tasks-side">
          <section className="os-panel" aria-label="Permission levels">
            <header className="os-panel-head"><h3 className="os-panel-title">Permission levels</h3></header>
            <div className="os-panel-body">
              <ol className="os-levels">
                {([1, 2, 3, 4] as const).map((rung) => (
                  <li key={rung}>
                    <span className={`os-chip ${levels[rung].tone}`}>{levels[rung].label}</span>
                    <span className="os-faint os-small">{perLevel[rung]} tool{perLevel[rung] === 1 ? "" : "s"}</span>
                    <p>{levels[rung].meaning}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>
          <CommandAccess active onChange={() => void load()} />
        </aside>
      </div>
    </ViewFrame>
  );
}
