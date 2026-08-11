# Ascend AI Monorepo

This repository contains the initial Sprint 1 scaffold for Project Ascend AI / TRH AI.

## Structure
- apps/api: TypeScript API service
- apps/web: React + Vite web shell
- packages/shared: shared types and helpers
- packages/db: SQL migrations
- docs: architecture, roadmap, PRD, backlog, contracts

## Quick Start
1. Copy the app env template to a local env file if needed: copy apps/api/.env.example apps/api/.env.
2. Run npm install.
3. Run npm run db:up.
4. Run your SQL migration tool against packages/db/migrations/001_core_init.sql and then packages/db/migrations/002_idempotency_keys.sql.
5. Run npm run dev:api.
6. Run npm run dev:web.
7. Optional desktop shell: npm run dev:desktop.
8. Silent desktop launch on Windows: double-click Launch-AscendAI.vbs.
9. Health check the API: npm run health:api.
10. Run the web regression test: npm run test --workspace @ascend/web.

## Desktop Packaging
- Build desktop distributables: npm run dist:desktop
- Build Windows artifacts: npm run dist:desktop:win
- Output folder: apps/desktop/release

## Silent Launch (Windows)
- Use Launch-AscendAI.vbs for a fully hidden startup path (no visible command prompt window).
- Launch-AscendAI.bat supports a hidden bootstrap flag (__hidden__) and is invoked by the VBS wrapper.

## Release Notes
### 0.1.4
- Desktop app version bumped to 0.1.4 so packaged installers and renderer runtime metadata are in sync with the latest UI/AI upgrades.

### 0.1.2
- Command Center actions now execute real task dispatch flows instead of only updating command text state.
- Added rapid duplicate-command suppression to prevent burst-click task queue spam.
- Added deterministic, load-aware agent assignment for command-routed tasks.
- Added voice auto-submit duplicate suppression so repeated ASR retries do not flood message sends.
- Windows desktop artifacts rebuilt and validated:
	- Portable smoke launch passed.
	- Silent setup installer smoke test passed (install, launch, no cmd.exe child process, cleanup).

## Dev Identity Headers
- API resolves actor identity from optional request headers:
	- x-ascend-user-email
	- x-ascend-user-name
- If omitted, DEV_USER_EMAIL and DEV_USER_DISPLAY_NAME from .env are used.

## Auth Modes
- AUTH_MODE=dev: accepts optional bearer token and falls back to dev identity headers/env.
- AUTH_MODE=jwt: requires Authorization Bearer token and validates it with AUTH_JWT_SECRET.
- Optional JWT constraints: AUTH_JWT_ISSUER and AUTH_JWT_AUDIENCE.

## API Storage Backends
- API_STORAGE_BACKEND=memory: runs fully local without Postgres (best for rapid UI iteration/live preview).
- API_STORAGE_BACKEND=postgres: uses database-backed routes and migrations.
- If using postgres mode, ensure DATABASE_URL and migrations are applied.

## Security Validation
- RBAC and idempotency integration checklist: apps/api/tests/rbac-idempotency-checklist.md

## Notes
- API route stubs are aligned with docs/08-openapi-v1.yaml.
- Initial schema migration is in packages/db/migrations/001_core_init.sql.
- Idempotency persistence migration is in packages/db/migrations/002_idempotency_keys.sql.
- Docker database config lives in infra/docker-compose.postgres.yml.
- Complete product vision is in docs/12-ascend-ai-complete-product-vision.md.
