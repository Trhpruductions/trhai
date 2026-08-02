# Project Ascend AI / TRH AI
## Sprint 1 Task Board (Weeks 1-2)

Date: 2026-08-01
Sprint goal: Deliver secure workspace onboarding and chat shell foundation with observability baseline.

## Sprint Scope
In scope:
- Monorepo and environment setup.
- Auth and workspace creation.
- RBAC middleware baseline.
- Chat shell (create conversation, send message, receive stub assistant response).
- Logging, metrics, tracing baseline.
- CI pipeline and code quality gates.

Out of scope:
- Full memory retrieval.
- Connector integrations.
- Billing quotas.

## Team and Ownership
- Product Lead: backlog clarity, acceptance sign-off.
- Tech Lead: architecture decisions, integration integrity.
- Backend Engineer A: auth/workspace/member APIs.
- Backend Engineer B: conversation/message APIs and RBAC middleware.
- Frontend Engineer: onboarding and chat shell UI.
- AI Engineer: model adapter interface and stub router.
- SRE/DevOps: CI/CD, environments, observability stack.
- QA Engineer: test plans, smoke and regression checks.

## Board Columns
- Todo
- In Progress
- In Review
- Done
- Blocked

## Tasks
1. S1-T01 Create monorepo scaffold
- Owner: Tech Lead
- Estimate: 3 points
- Priority: P0
- Dependencies: none
- Acceptance criteria:
  - Apps and services folders created.
  - Shared package config and lint/format scripts defined.
  - Local startup command runs all essential services.

2. S1-T02 Configure environments and secrets baseline
- Owner: SRE
- Estimate: 3 points
- Priority: P0
- Dependencies: S1-T01
- Acceptance criteria:
  - Dev/stage env templates created.
  - Secrets loaded from secure mechanism, no plaintext in repo.
  - Startup fails fast when required env vars are missing.

3. S1-T03 Implement authentication integration
- Owner: Backend Engineer A
- Estimate: 5 points
- Priority: P0
- Dependencies: S1-T01, S1-T02
- Acceptance criteria:
  - Login/logout works through configured auth provider.
  - Authenticated user context attached to API requests.
  - Unauthorized access returns 401 consistently.

4. S1-T04 Build workspace creation API
- Owner: Backend Engineer A
- Estimate: 5 points
- Priority: P0
- Dependencies: S1-T03
- Acceptance criteria:
  - User can create workspace with name.
  - Owner membership created atomically.
  - Duplicate slug collisions handled safely.

5. S1-T05 Add RBAC middleware baseline
- Owner: Backend Engineer B
- Estimate: 5 points
- Priority: P0
- Dependencies: S1-T03, S1-T04
- Acceptance criteria:
  - Role checks enforced on protected routes.
  - Permission errors return structured response with code.
  - Denials create audit events.

6. S1-T06 Implement conversation create/list APIs
- Owner: Backend Engineer B
- Estimate: 5 points
- Priority: P1
- Dependencies: S1-T05
- Acceptance criteria:
  - Create conversation endpoint stores workspace and mode.
  - List endpoint paginates and scopes by workspace.
  - Unit and integration tests pass.

7. S1-T07 Implement message send endpoint with assistant stub
- Owner: Backend Engineer B + AI Engineer
- Estimate: 8 points
- Priority: P0
- Dependencies: S1-T06
- Acceptance criteria:
  - User message persisted with ordering guarantees.
  - Assistant stub response generated and persisted.
  - Trace ID included in response metadata.

8. S1-T08 Build onboarding flow UI
- Owner: Frontend Engineer
- Estimate: 5 points
- Priority: P1
- Dependencies: S1-T03, S1-T04
- Acceptance criteria:
  - User can create/select workspace after login.
  - Errors are human-readable and recoverable.
  - Basic responsive layout for desktop and mobile.

9. S1-T09 Build chat shell UI with streaming-ready architecture
- Owner: Frontend Engineer
- Estimate: 8 points
- Priority: P0
- Dependencies: S1-T06, S1-T07
- Acceptance criteria:
  - Thread list and active conversation panel render correctly.
  - Message send and receive flow works end-to-end.
  - UI state model supports future token streaming events.

10. S1-T10 Setup structured logging and tracing
- Owner: SRE + Backend Engineer B
- Estimate: 5 points
- Priority: P0
- Dependencies: S1-T01
- Acceptance criteria:
  - Request logs include user_id, workspace_id, trace_id.
  - Distributed traces visible in staging dashboard.
  - Error logs include service and route tags.

11. S1-T11 Setup CI pipeline and quality gates
- Owner: SRE
- Estimate: 5 points
- Priority: P0
- Dependencies: S1-T01
- Acceptance criteria:
  - CI runs lint, typecheck, unit tests on PRs.
  - Blocking checks required for merge.
  - Build artifact generated for deploy stage.

12. S1-T12 Author QA test plan and run smoke tests
- Owner: QA Engineer
- Estimate: 3 points
- Priority: P1
- Dependencies: S1-T03 through S1-T11
- Acceptance criteria:
  - Smoke test checklist covers auth, workspace, chat shell.
  - Defects logged with severity and reproducible steps.
  - Sprint sign-off includes pass/fail summary.

## Sprint Acceptance Gates
- Gate 1: Security baseline
  - No critical auth/RBAC issues.

- Gate 2: Product baseline
  - New user can onboard and run first assistant message.

- Gate 3: Operations baseline
  - Logs and traces confirm end-to-end visibility.

## Daily Cadence
- Standup: blockers, owner, ETA.
- Midday integration check: backend/frontend contract drift review.
- End-of-day update: completed tasks and risk changes.

## Risk Watchlist (Sprint 1)
1. Auth provider integration delays.
- Mitigation: keep local dev auth fallback for blocked environments.

2. RBAC edge cases on new routes.
- Mitigation: enforce route-level test templates before merge.

3. Chat API and UI contract mismatch.
- Mitigation: shared typed client and contract tests.

## Definition of Done (Sprint)
- All P0 tasks complete.
- No open critical or high security defects.
- End-to-end demo recorded and accepted by Product Lead.
