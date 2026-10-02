"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { apiGet } from "../../lib/api";
import {
  back, emptyHistory, forward, hostOf, looksLikeUrl, normalizeUrl, paragraphsOf, visit, visitText,
  type History, type Visit
} from "../../lib/browser";
import { Icon } from "../ui/Icon";
import { ViewFrame } from "../ui/ViewFrame";
import { useAssistantState } from "../state/assistant";
import { useNav } from "../state/nav";
import { useNotify } from "../state/notify";
import "./views.css";

// The web, read as text. A search goes to DuckDuckGo through TRH AI's service
// - the same search the web_search tool runs - and a page is fetched the same
// way fetch_url fetches one, behind the same checks on where it may go: never
// this PC or its local network. What comes back is the page's words and its
// links; nothing on the page runs, and nothing but the request for it is
// sent. For anything that needs the real page - a login, a video - there is
// always a link to open it in the browser.

type Result = { title: string; url: string; snippet: string };
type Page = { url: string; title: string; text: string; truncated: boolean; links: Array<{ text: string; url: string }> };

/** What is on screen, and the visit it belongs to - so a visit not yet answered is plainly loading. */
type Shown =
  | { visit: Visit; kind: "results"; results: Result[] }
  | { visit: Visit; kind: "page"; page: Page }
  | { visit: Visit; kind: "problem"; message: string };

const linksShown = 30;

export function BrowserView() {
  const { send } = useAssistantState();
  const { go } = useNav();
  const { notify } = useNotify();
  const [history, setHistory] = useState<History>(emptyHistory);
  const [input, setInput] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [allLinksFor, setAllLinksFor] = useState<string | null>(null);
  const [visited, setVisited] = useState<Array<{ url: string; title: string }>>([]);
  /** The words typed for a page that would not open, offered as a search instead. */
  const [typed, setTyped] = useState<string | null>(null);

  const current = history.visits[history.index] ?? null;
  const loading = current !== null && shown?.visit !== current;
  const results = shown?.kind === "results" ? shown.results : null;
  const page = shown?.kind === "page" ? shown.page : null;
  const problem = shown?.kind === "problem" && shown.visit === current ? shown.message : null;
  const allLinks = page !== null && allLinksFor === page.url;

  // Whatever the history points at is fetched; a reply for a visit that has
  // since been left is dropped.
  useEffect(() => {
    if (!current) return;
    let live = true;
    const request = current.kind === "search"
      ? apiGet<{ results: Result[] }>(`/v1/web/search?q=${encodeURIComponent(current.query)}`)
      : apiGet<Page>(`/v1/web/read?url=${encodeURIComponent(current.url)}`);
    void request.then((result) => {
      if (!live) return;
      if (!result.ok) {
        setShown({ visit: current, kind: "problem", message: result.reason });
      } else if (current.kind === "search") {
        setShown({ visit: current, kind: "results", results: (result.data as { results: Result[] }).results });
      } else {
        const opened = result.data as Page;
        setShown({ visit: current, kind: "page", page: opened });
        setVisited((prior) => [{ url: opened.url, title: opened.title }, ...prior.filter((entry) => entry.url !== opened.url)].slice(0, 20));
      }
    });
    return () => { live = false; };
  }, [current]);

  /** Move through the history, keeping the address bar on where you are. */
  const move = (next: History) => {
    setHistory(next);
    const there = next.visits[next.index];
    if (there) setInput(visitText(there));
  };
  const goTo = (next: Visit) => move(visit(history, next));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    const isAddress = looksLikeUrl(value);
    setTyped(isAddress && !/^https?:\/\//i.test(value) ? value : null);
    goTo(isAddress ? { kind: "page", url: normalizeUrl(value) } : { kind: "search", query: value });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      notify({ level: "success", title: "Link copied", body: url, source: "BROWSER" });
    } catch {
      notify({ level: "error", title: "Could not copy", body: "The clipboard is not available here.", source: "BROWSER" });
    }
  };

  const paragraphs = useMemo(() => (page ? paragraphsOf(page.text) : []), [page]);

  return (
    <ViewFrame id="browser" actions={<span className="os-chip" title="Searches go to DuckDuckGo through TRH AI's service">Search: DuckDuckGo</span>}>
      <div className="os-tasks-layout">
        <div className="os-tasks-main">
          <form className="os-panel os-browser-bar" onSubmit={submit} role="search">
            <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label="Back" disabled={history.index <= 0}
              onClick={() => { setTyped(null); move(back(history)); }}>
              <Icon name="chevronLeft" size={16} />
            </button>
            <button type="button" className="os-btn os-btn-ghost os-btn-icon os-btn-sm" aria-label="Forward" disabled={history.index >= history.visits.length - 1}
              onClick={() => { setTyped(null); move(forward(history)); }}>
              <Icon name="chevronRight" size={16} />
            </button>
            <label className="os-browser-input">
              <Icon name={current?.kind === "page" ? "external" : "search"} size={15} />
              <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Search the web, or enter an address"
                aria-label="Search the web, or enter an address" spellCheck={false} />
            </label>
            <button type="submit" className="os-btn os-btn-sm os-btn-primary" disabled={!input.trim() || loading}>{loading ? "Loading…" : "Go"}</button>
          </form>

          {!current ? (
            <div className="os-panel">
              <div className="os-empty">
                <strong>Search the web, or open a page</strong>
                <p>Pages open as text - their words and their links. Nothing on them runs, and nothing is sent but the request for the page. This PC and its local network are never fetched.</p>
              </div>
            </div>
          ) : problem ? (
            <div className="os-panel">
              <div className="os-empty">
                <strong>{current.kind === "search" ? "The search did not work" : "That page did not open"}</strong>
                <p>{problem}</p>
                <div className="os-browser-problem-actions">
                  {typed ? (
                    <button type="button" className="os-btn os-btn-sm os-btn-primary" onClick={() => { setTyped(null); goTo({ kind: "search", query: typed }); }}>
                      <Icon name="search" size={14} />Search for &ldquo;{typed}&rdquo; instead
                    </button>
                  ) : null}
                  {current.kind === "page" ? <a className="os-btn os-btn-sm" href={current.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open in your browser</a> : null}
                </div>
              </div>
            </div>
          ) : loading && !results && !page ? (
            <div className="os-panel"><p className="os-faint os-browser-pad">{current.kind === "search" ? "Searching…" : "Opening the page…"}</p></div>
          ) : results ? (
            <section className="os-panel" aria-label="Search results">
              <header className="os-panel-head">
                <h3 className="os-panel-title">Results</h3>
                <span className="os-faint os-small">{results.length} for &ldquo;{current.kind === "search" ? current.query : ""}&rdquo;</span>
              </header>
              <div className="os-panel-body">
                {results.length === 0 ? <p className="os-faint">Nothing came back for that. Try other words.</p> : (
                  <ol className="os-results">
                    {results.map((result) => (
                      <li key={result.url}>
                        <button type="button" className="os-result-title" onClick={() => goTo({ kind: "page", url: result.url })}>{result.title}</button>
                        <span className="os-result-host os-mono">{hostOf(result.url)}</span>
                        {result.snippet ? <p className="os-result-snippet">{result.snippet}</p> : null}
                        <a className="os-result-open" href={result.url} target="_blank" rel="noreferrer">Open in your browser<Icon name="external" size={12} /></a>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          ) : page ? (
            <article className="os-panel os-reader" aria-label={page.title}>
              <header className="os-reader-head">
                <h3 className="os-reader-title">{page.title}</h3>
                <span className="os-mono os-faint os-small os-reader-url">{page.url}</span>
                <div className="os-reader-actions">
                  <button type="button" className="os-btn os-btn-sm os-btn-primary" onClick={() => { void send(`Read ${page.url} and tell me what it says.`); go("chat"); }}>
                    <Icon name="message" size={14} />Ask TRH AI about this page
                  </button>
                  <a className="os-btn os-btn-sm" href={page.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open in your browser</a>
                  <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => void copy(page.url)}><Icon name="copy" size={14} />Copy link</button>
                </div>
              </header>
              <div className="os-reader-body">
                {page.truncated ? <p className="os-faint os-small">A long page - the first part is shown. Open it in your browser for the rest.</p> : null}
                {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              </div>
              {page.links.length ? (
                <footer className="os-reader-links">
                  <span className="os-label">Links on this page · {page.links.length}</span>
                  <ul>
                    {(allLinks ? page.links : page.links.slice(0, linksShown)).map((link) => (
                      <li key={link.url}>
                        <button type="button" onClick={() => goTo({ kind: "page", url: link.url })} title={link.url}>{link.text}</button>
                        <span className="os-faint os-mono">{hostOf(link.url)}</span>
                      </li>
                    ))}
                  </ul>
                  {page.links.length > linksShown && !allLinks ? (
                    <button type="button" className="os-btn os-btn-sm os-btn-ghost" onClick={() => setAllLinksFor(page.url)}>Show all {page.links.length}</button>
                  ) : null}
                </footer>
              ) : null}
            </article>
          ) : null}
        </div>

        <aside className="os-tasks-side">
          <section className="os-panel" aria-label="Pages read">
            <header className="os-panel-head"><h3 className="os-panel-title">Read this session</h3></header>
            <div className="os-panel-body">
              {visited.length === 0 ? <p className="os-faint os-small">Pages you open are listed here until you leave.</p> : (
                <ul className="os-visited">
                  {visited.map((entry) => (
                    <li key={entry.url}>
                      <button type="button" onClick={() => goTo({ kind: "page", url: entry.url })}>
                        <span>{entry.title}</span>
                        <span className="os-faint os-mono">{hostOf(entry.url)}</span>
                      </button>
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
