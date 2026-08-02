# Project Ascend AI / TRH AI
## Engineering Backlog (Epics, Stories, Acceptance)

Date: 2026-08-01
Status: Draft backlog for Phase 1 MVP

## Planning Conventions
- Priority scale: P0 critical, P1 high, P2 medium.
- Story points: 1, 2, 3, 5, 8, 13.
- Definition of done: code, tests, observability, docs, security checks, review approved.

## Epic E1: Identity, Workspaces, and RBAC
Goal: Secure workspace creation, membership, and permission model.

Stories:
1. E1-S1 Workspace creation flow
- Priority: P0
- Points: 5
- Owner: Backend
- Acceptance:
  - User can create workspace from onboarding.
  - Workspace has default roles and owner assigned.
  - Workspace ID appears in all downstream API calls.

2. E1-S2 Member invitations and role assignment
- Priority: P1
- Points: 5
- Owner: Backend + Frontend
- Acceptance:
  - Owner/Admin can invite by email.
  - Role assignment supports Owner/Admin/Member/Viewer.
  - Invite links expire and are single-use.

3. E1-S3 RBAC policy middleware
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - All protected routes enforce policy checks.
  - Unauthorized requests return deterministic error codes.
  - Audit event written for denied privileged actions.

## Epic E2: Assistant Core and Session Handling
Goal: Stable multi-turn assistant with workspace context.

Stories:
1. E2-S1 Chat session lifecycle
- Priority: P0
- Points: 5
- Owner: Backend
- Acceptance:
  - Create/read/update session records.
  - Message ordering preserved under concurrency.
  - Session retrieval scoped to workspace.

2. E2-S2 Streaming responses in UI
- Priority: P1
- Points: 5
- Owner: Frontend
- Acceptance:
  - User sees token streaming and final message state.
  - Error states are recoverable without refresh.
  - Conversation state persists across navigation.

3. E2-S3 Mode switching (general, coding, business)
- Priority: P1
- Points: 3
- Owner: Full-stack
- Acceptance:
  - Mode selection stored per conversation.
  - System prompt profile changes by mode.
  - Telemetry tags include active mode.

## Epic E3: Orchestration and Model Routing
Goal: Deterministic execution control and cost-aware routing.

Stories:
1. E3-S1 Agent orchestrator task pipeline
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - Task pipeline supports plan, execute, verify phases.
  - Side-effect actions require policy gate.
  - Per-step trace ID emitted to logs.

2. E3-S2 Model router v1
- Priority: P0
- Points: 8
- Owner: AI Engineer
- Acceptance:
  - Route by task type and latency profile.
  - Fallback chain executes on model errors.
  - Usage/cost metadata captured per request.

3. E3-S3 Prompt registry and templates
- Priority: P1
- Points: 5
- Owner: AI Engineer
- Acceptance:
  - Prompt templates versioned in config.
  - Rollback to prior template version possible.
  - Prompt changes observable in audit trail.

## Epic E4: Memory and Retrieval
Goal: Trusted memory with explicit user control.

Stories:
1. E4-S1 Memory write pipeline
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - Memory candidates extracted per conversation.
  - Writes tagged with source and confidence.
  - Duplicate suppression prevents memory spam.

2. E4-S2 Memory controls UI
- Priority: P0
- Points: 5
- Owner: Frontend
- Acceptance:
  - User can pin, edit label, forget memory item.
  - Deletion reflects in retrieval within 60 seconds.
  - Control actions logged to audit stream.

3. E4-S3 Retrieval context builder
- Priority: P1
- Points: 8
- Owner: AI Engineer
- Acceptance:
  - Retrieval limited by workspace and permissions.
  - Context pack includes top-k plus recency heuristics.
  - Quality benchmark exceeds baseline by 15 percent.

## Epic E5: Coding Assistant Mode
Goal: Deliver practical software development workflows.

Stories:
1. E5-S1 Project file indexing
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - Index source files up to configured size limits.
  - Incremental reindex after file changes.
  - Index scoped per workspace/project.

2. E5-S2 Code generation and explanation workflow
- Priority: P1
- Points: 5
- Owner: Full-stack
- Acceptance:
  - User can request generate/explain/debug from same thread.
  - Output includes artifact snapshots.
  - Model output errors surfaced clearly.

3. E5-S3 Patch verification harness
- Priority: P1
- Points: 8
- Owner: QA + Backend
- Acceptance:
  - Optional test/lint command runs post-change.
  - Results attached to assistant response metadata.
  - Failure states include actionable next-step hints.

## Epic E6: Automation Engine and Connectors
Goal: Reliable trigger-action workflows with safeguards.

Stories:
1. E6-S1 Workflow definition schema
- Priority: P0
- Points: 5
- Owner: Backend
- Acceptance:
  - Supports trigger, conditions, actions, retries.
  - Versioned workflow definitions with migration support.
  - Schema validation rejects invalid graphs.

2. E6-S2 Connector framework (OAuth + secrets)
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - Connectors can request scoped permissions.
  - Secrets stored encrypted and rotated safely.
  - Connector actions emit structured execution logs.

3. E6-S3 Idempotency and replay controls
- Priority: P0
- Points: 8
- Owner: Backend + SRE
- Acceptance:
  - Idempotency key required for side effects.
  - Failed jobs land in dead-letter queue.
  - Replay from dead-letter reproduces expected state.

## Epic E7: Team Collaboration
Goal: Shared workspace collaboration features.

Stories:
1. E7-S1 Shared project threads
- Priority: P1
- Points: 5
- Owner: Frontend + Backend
- Acceptance:
  - Team members can view and continue shared threads.
  - Permission checks enforce role restrictions.
  - Thread history includes actor attribution.

2. E7-S2 Comments and annotations
- Priority: P2
- Points: 3
- Owner: Frontend
- Acceptance:
  - Users can leave comments on artifacts.
  - Mentions generate in-app notifications.
  - Comment edits are versioned.

## Epic E8: Billing, Quotas, and Plans
Goal: Enforce subscription limits and usage visibility.

Stories:
1. E8-S1 Usage event collector
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - Captures tokens, generation jobs, storage usage.
  - Events linked to user, workspace, plan.
  - Collector handles burst traffic without drops.

2. E8-S2 Quota enforcement middleware
- Priority: P0
- Points: 5
- Owner: Backend
- Acceptance:
  - Requests over limit are blocked with clear errors.
  - Grace thresholds configurable per plan.
  - Quota counters update near real-time.

3. E8-S3 Usage dashboard v1
- Priority: P1
- Points: 5
- Owner: Frontend
- Acceptance:
  - Daily and monthly usage charts by feature class.
  - Alert banner for nearing quota limits.
  - Export usage CSV.

## Epic E9: Security and Compliance Baseline
Goal: Production-grade security controls for Phase 1.

Stories:
1. E9-S1 Secrets and key management
- Priority: P0
- Points: 5
- Owner: SRE
- Acceptance:
  - No plaintext secrets in code or config files.
  - Secrets retrieval audited.
  - Key rotation runbook documented.

2. E9-S2 Audit log pipeline
- Priority: P0
- Points: 8
- Owner: Backend
- Acceptance:
  - All privileged actions logged with actor and timestamp.
  - Logs immutable for retention window.
  - Admin can query logs by workspace and date.

3. E9-S3 Data deletion/export workflows
- Priority: P1
- Points: 8
- Owner: Backend
- Acceptance:
  - User can request data export.
  - User can request account/workspace deletion.
  - Deletion and export tracked via job status.

## Epic E10: Reliability, Observability, and Operations
Goal: Stable operations under load and failure.

Stories:
1. E10-S1 OpenTelemetry instrumentation
- Priority: P0
- Points: 5
- Owner: SRE + Backend
- Acceptance:
  - End-to-end trace for assistant requests.
  - Error budget dashboard live.
  - P95 latency dashboards per feature.

2. E10-S2 Incident response runbooks
- Priority: P1
- Points: 3
- Owner: SRE
- Acceptance:
  - Runbooks for model outage, queue backlog, auth outage.
  - On-call escalation matrix defined.
  - Simulated incident drill completed.

3. E10-S3 Load and resilience tests
- Priority: P1
- Points: 8
- Owner: QA + SRE
- Acceptance:
  - Concurrency test meets target throughput.
  - Graceful degradation verified during provider failure.
  - Recovery time objective validated in staging.

## Release Buckets
- Release R1 (Weeks 1-4): E1, E2, E3 foundation, E4 baseline.
- Release R2 (Weeks 5-8): E5, E6, E9 baseline.
- Release R3 (Weeks 9-12): E7, E8, E10 hardening and launch.

## Top Backlog Dependencies
1. RBAC middleware before team and automation features.
2. Model router before cost controls and SLA tuning.
3. Memory controls before large-scale beta onboarding.
4. Usage collector before subscription gating.
