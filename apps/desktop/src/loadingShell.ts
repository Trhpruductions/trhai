// What the desktop window shows while the local services come up.
//
// The window opens before the web app is listening - the API, the model
// server and the interface are all started alongside it - so this is the
// first thing anyone sees when TRH AI opens. It was a plain grey box headed
// "Vexora AI" with a sentence of status, from an earlier version of the app;
// it now matches the loading screen the interface itself shows next, so
// opening the app reads as one continuous start rather than two products.
//
// Self-contained on purpose: it is written to a file and loaded from disk, so
// it can reference nothing over the network, and nothing here may depend on
// the services it is waiting for.

/** Text, safe to place in HTML. The reasons are ours, but an URL can carry anything. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export function loadingShellHtml(reason: string, details?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TRH AI</title>
<style>
  :root { --cyan: #38d0ff; --cyan-bright: #8be9ff; --ink: #eaf6ff; --mut: #8aa5bd; --faint: #5f7d94; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; place-items: center; overflow: hidden;
    color: var(--ink); font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
    background:
      radial-gradient(42% 46% at 50% 42%, rgba(56, 208, 255, 0.22), rgba(56, 208, 255, 0.04) 55%, transparent 72%),
      radial-gradient(circle at 1px 1px, rgba(120, 190, 255, 0.16) 1px, transparent 1.6px) 0 0 / 34px 34px,
      radial-gradient(90% 80% at 50% 40%, #0b2448 0%, #061226 48%, #03060c 100%);
  }
  main { display: flex; flex-direction: column; align-items: center; text-align: center; animation: rise 700ms cubic-bezier(.2,.8,.2,1) both; }
  .core { position: relative; width: 200px; height: 200px; display: grid; place-items: center; }
  .core svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .core circle { fill: none; stroke: var(--cyan); }
  .r1 { stroke-opacity: .32; stroke-width: 1; stroke-dasharray: 3 9; animation: spin 40s linear infinite; transform-origin: 50% 50%; }
  .r2 { stroke-opacity: .7; stroke-width: 1.6; stroke-dasharray: 90 30 12 30; animation: spin 18s linear infinite reverse; transform-origin: 50% 50%; filter: drop-shadow(0 0 5px rgba(56,208,255,.8)); }
  .r3 { stroke-opacity: .5; stroke-width: 1; stroke-dasharray: 40 8; animation: spin 26s linear infinite; transform-origin: 50% 50%; }
  .heart {
    width: 92px; height: 92px; border-radius: 50%;
    background: radial-gradient(circle at 50% 45%, rgba(191, 244, 255, .9), rgba(56, 208, 255, .55) 38%, rgba(10, 58, 110, .15) 70%, transparent 72%);
    box-shadow: 0 0 60px rgba(56, 208, 255, .45);
    animation: breathe 4s ease-in-out infinite;
  }
  .mark { position: absolute; inset: 0; display: grid; place-content: center; }
  .mark b { font: 700 22px "Bahnschrift", "Segoe UI", sans-serif; letter-spacing: .24em; text-indent: .24em; color: #fff; text-shadow: 0 0 14px rgba(56,208,255,.8); }
  .mark i { font: 600 12px "Bahnschrift", "Segoe UI", sans-serif; font-style: normal; letter-spacing: .5em; text-indent: .5em; color: var(--cyan-bright); }
  h1 { margin: 22px 0 0; font: 700 34px "Bahnschrift", "Segoe UI", sans-serif; letter-spacing: .42em; text-indent: .42em; color: #fff; text-shadow: 0 0 22px rgba(56,208,255,.6); }
  .tag { margin: 6px 0 0; font: 600 10.5px "Bahnschrift", "Segoe UI", sans-serif; letter-spacing: .46em; text-indent: .46em; color: var(--mut); }
  .bar { position: relative; width: 340px; height: 3px; margin: 30px 0 14px; border-radius: 3px; overflow: hidden; background: rgba(70,160,230,.16); }
  .bar::after { content: ""; position: absolute; top: 0; bottom: 0; width: 30%; background: linear-gradient(90deg, transparent, var(--cyan-bright), transparent); animation: scan 1.6s ease-in-out infinite; }
  .status { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: #c9dcec; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(56,208,255,.22); border-top-color: var(--cyan); animation: spin .8s linear infinite; }
  .details { margin: 8px 0 0; max-width: 460px; font-size: 12px; line-height: 1.5; color: var(--faint); }
  .foot { position: fixed; bottom: 18px; left: 0; right: 0; text-align: center; font-size: 11px; letter-spacing: .08em; color: var(--faint); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 0%, 100% { transform: scale(.94); opacity: .85; } 50% { transform: scale(1.04); opacity: 1; } }
  @keyframes scan { from { left: -30%; } to { left: 100%; } }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .r1 { animation-duration: 120s; } .r2 { animation-duration: 60s; } .r3 { animation-duration: 90s; }
    .heart { animation-duration: 10s; } .bar::after { animation-duration: 5s; }
  }
</style>
</head>
<body>
  <main role="status" aria-live="polite">
    <div class="core" aria-hidden="true">
      <svg viewBox="0 0 100 100">
        <circle class="r1" cx="50" cy="50" r="49"/>
        <circle class="r2" cx="50" cy="50" r="44"/>
        <circle class="r3" cx="50" cy="50" r="38"/>
      </svg>
      <div class="heart"></div>
      <div class="mark"><b>TRH</b><i>AI</i></div>
    </div>
    <h1>TRH AI</h1>
    <p class="tag">LIVING INTELLIGENCE SYSTEM</p>
    <div class="bar" aria-hidden="true"></div>
    <p class="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(reason)}</p>
    ${details ? `<p class="details">${escapeHtml(details)}</p>` : ""}
  </main>
  <p class="foot">Runs entirely on this machine</p>
</body>
</html>`;
}
