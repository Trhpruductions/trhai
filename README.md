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
| **Marketplace / Agents** | Ten agents with ratings, version history and install. The active agent changes the assistant's suggestions and focus. |
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
`http://127.0.0.1:5173`. To run them separately use `npm run dev:api` and
`npm run dev:web`; for the desktop shell use `npm run dev:desktop`, which loads
the same web port.

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

489 tests across the API, web app and shared packages. Also available:
`npm run typecheck`, `npm run lint`, `npm run build`.

## Structure

- `apps/api` — API service. Assistant, memory, knowledge, accounts.
- `apps/web` — React + Vite shell. All destinations and the widget dashboard.
- `apps/desktop` — Electron shell providing host telemetry, file and command access.
- `packages/shared` — project planner and generator; the code that writes code.
- `packages/db` — SQL migrations, used only in the optional Postgres mode.
- `docs` — architecture, roadmap, PRD, backlog, contracts, product vision.
- `generated-projects` — output of the build engine, deliberately outside the workspaces.

## Optional Postgres mode

The default `API_STORAGE_BACKEND=memory` needs no external services. To use Postgres
instead:

```bash
npm run db:up
```

Then apply `packages/db/migrations/001_core_init.sql` and `002_idempotency_keys.sql`,
set `DATABASE_URL`, and set `API_STORAGE_BACKEND=postgres`.

## Configuration

Copy `apps/api/.env.example` to `apps/api/.env` to change any of these.

- `PORT` — API port, default 4000.
- `API_STORAGE_BACKEND` — `memory` (default) or `postgres`.
- `CORS_ORIGIN` — which browser origins may call the API. Defaults to this
  machine's own origins on any port. The API listening on localhost does not by
  itself stop a page on a site you visit from calling it, and the assistant,
  memory and knowledge endpoints take no credentials, so the default is
  deliberately not `*`. Accepts a comma-separated list, or `*` to allow all.
- `AUTH_MODE` — `dev` accepts optional bearer tokens and falls back to dev identity;
  `jwt` requires a bearer token validated with `AUTH_JWT_SECRET`, optionally
  constrained by `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE`.
- `DEV_USER_EMAIL`, `DEV_USER_DISPLAY_NAME` — identity used in dev mode when the
  `x-ascend-user-email` and `x-ascend-user-name` headers are absent.
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
- RBAC and idempotency checklist: `apps/api/tests/rbac-idempotency-checklist.md`.
