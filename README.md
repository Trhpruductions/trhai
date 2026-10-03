# Vexora AI

A local-first AI workspace: a desktop/web shell that builds working software from a
description, remembers what you tell it, answers from documents you add, and runs
automation flows.

## Read this first

**Vexora runs entirely on your own machine, and costs nothing to run.** No account,
no API key, no third-party service. That is a deliberate constraint, and it is
enforced by tests: the build fails if anyone adds a hosted provider key, a hosted
provider SDK, or a non-loopback URL to the model client.

Answers come from a local model through [Ollama](https://ollama.com) when one is
installed, and the app starts and stops that server itself — opening Vexora is the
only thing you have to do. With no model installed it still runs, answering from
your saved memory and your documents and saying plainly when it has neither.

The assistant has tools it can call and chain, so it can look something up, do
arithmetic exactly, work out a date, write a file, and build a working app. Two rules
hold throughout:

- **A tool that finds nothing reports that it found nothing.** Told an empty result a
  model can say so; told nothing at all it invents. That difference is the whole
  design.
- **Nothing claims to have happened unless it did.** A save reports what was actually
  written; a build that fails partway reports nothing as built.

Every reply is labelled with how it was produced — quoted from your notes, quoted from
a document, or written by the model — and with which tools ran.

## What works today

| Area | What it does |
| --- | --- |
| **Build** | Turns "build a task tracker where projects have many tasks" into a running REST API with JSON persistence, validation, referential integrity and a smoke suite. Reads the request for entities, fields and relations, and adds a dashboard, kanban board or calendar view when the request calls for one. |
| **Assistant** | Answers from saved memory, your documents, or earlier in the conversation — and says plainly when nothing matches. Never invents an answer. |
| **Memory** | "remember that ..." stores a fact; pin, rename and forget from the Memory panel. Survives restarts. |
| **Knowledge** | Paste or import text files; questions are answered by quoting the matching passage with its source. |
| **Automation** | Block canvas — IF / ELSE / WAIT / RUN SCRIPT and more. Dry run performs nothing; a live run executes control flow and scripts, and skips anything needing credentials with the reason stated. |
| **Agents** | Ten agents - programmer, designer, researcher and more - chosen in the settings rail. The active one shapes how the model answers, not what it can do. The doctor, lawyer and financial-advisor agents add a professional-advice caveat to every reply, the same way the matching personalities do. |
| **Machine readings** | Asked how the computer is doing, the assistant answers from the same readings as the dashboard - processor, memory and the programs using it, graphics card and its temperature margin, disk, network, uptime - and never estimates one. |
| **Personalities** | Ten profiles that change tone and suggestions. The medical, legal and cyber-security profiles always append a professional-advice disclaimer — enforced in the response path, not left to the wording. |
| **Widgets** | Draggable, resizable dashboard widgets. Widgets with no real data source say so instead of showing a plausible number. |
| **Calendar** | Local events with live relative times. No connected account needed. |
| **Projects / Files / Terminal** | Real host inventory and command execution, through the desktop shell. |

## What does not work, and why

Three destinations are visible but disclosed as planned, because each needs a
capability this build does not have:

- **Browser** — needs an embedded browsing engine with its own permission gate.
- **Email** — needs a connected mail account.
- **Plugins** — needs the Plugin SDK.

They explain themselves in the UI rather than presenting a dead link.

## Quick start

No database and no Docker required — the API defaults to in-memory storage with a
JSON file for anything that must survive a restart.

```bash
npm install
```

```bash
npm run dev:all
```

That starts the API on `http://127.0.0.1:4000` and the web app on
`http://127.0.0.1:3210`. To run them separately use `npm run dev:api` and
`npm run dev:web`; for the desktop shell use `npm run dev:desktop`, which loads
the same web port. To check the whole stack is up and answering:

```bash
npm run smoke:web-stack
```

Set `ASCEND_WEB_PORT` to move the web app; the desktop shell reads the same
variable, so the two stay in step.

Check the API is up:

```bash
npm run health:api
```

## Tests

```bash
npm test
```

Runs the tests of every workspace: the API, the web client, the desktop shell
and the shared packages. Also available: `npm run typecheck`, `npm run lint`,
`npm run build`. To run one API test file, keep the isolation setup - a bare
`node --test` on a file runs against your real data:

```bash
cd apps/api && node --test --import tsx --import ./tests/setup/isolate-state.ts tests/agent-loop.test.ts
```

## Structure

- `apps/api` — API service. Assistant, memory, knowledge, accounts.
- `apps/trhai-web` — the client: a Next.js app, served on port 3210. This is
  what the desktop shell and the launcher open.
- `apps/web` — the earlier React + Vite client. Superseded by `apps/trhai-web`;
  nothing starts it.
- `apps/desktop` — Electron shell providing host telemetry, file and command access.
- `packages/shared` — project planner and generator; the code that writes code.
- `docs` — architecture, roadmap, PRD, backlog, contracts, product vision.
- `generated-projects` — output of the build engine, deliberately outside the workspaces.

## Configuration

Copy `.env.example` to `.env` at the repository root to change any of these;
it documents every setting.

- `PORT` — API port, default 4000.
- `OLLAMA_MODEL` — which local model answers. `OLLAMA_NUM_CTX` — the context
  window every request asks for, default 16384. The assistant's instructions and
  tool list need more than Ollama's own default of 4096; a smaller window cuts
  them off without any error, so anything under 8192 is raised to 8192. It is
  also the longest a reply may be: a model that runs past it is stopped, and
  the reply is reported as too long rather than shown.
- `CORS_ORIGIN` — which browser origins may call the API. Defaults to this
  machine's own origins on any port. The API listening on localhost does not by
  itself stop a page on a site you visit from calling it, and the assistant,
  memory and knowledge endpoints take no credentials, so the default is
  deliberately not `*`. Accepts a comma-separated list, or `*` to allow all.
- `ASSIST_MEMORY_FILE`, `ASSIST_KNOWLEDGE_FILE` — where assistant memory and knowledge
  documents persist. Set `ASSIST_MEMORY_PERSIST=off` to keep memory in RAM only.

## Desktop packaging

```bash
npm run dist:desktop:win
```

Artifacts land in `apps/desktop/release`. `npm run dist:desktop` builds for the
current platform. On Windows, `Launch-Vexora.vbs` starts the packaged app with no
visible console window.

## Notes

- Route stubs are aligned with `docs/08-openapi-v1.yaml`.
- The complete product vision is `docs/12-ascend-ai-complete-product-vision.md`.
