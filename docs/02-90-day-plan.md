# Project Ascend AI / TRH AI
## 90-Day Build Plan (Execution Version)

Date: 2026-08-01
Cadence: 12 weeks
Operating model: 2-week sprints + weekly release trains

## Objective
Ship a production-ready Phase 1 MVP that proves the AI Operating System core loop:
Ask -> Plan -> Execute -> Verify -> Remember.

## Team Assumptions (Minimum)
- 1 Product Lead
- 1 Tech Lead/Architect
- 3 Full-Stack Engineers
- 1 ML/AI Engineer
- 1 DevOps/SRE
- 1 QA/Automation Engineer
- 1 Designer (part-time acceptable)

## Success Metrics (By Day 90)
- DAU/WAU >= 0.35 in beta cohort.
- P95 chat latency <= 2.5 seconds (standard tasks).
- Deterministic automation success rate >= 95%.
- Memory recall helpfulness score >= 4.2/5.
- Task completion rate for coding workflows >= 80%.
- Gross margin model validated for Pro tier assumptions.
- Live execution trust score >= 95% (users report that progress reflects real work, not simulation).
- AI Core state accuracy >= 99% (visual state matches runtime state events).
- Interaction frame stability >= 95% of sessions within motion budget on reference hardware.

## Scope for Day 90
In-scope:
- Conversational assistant (text + basic voice)
- Workspace/project context
- Memory with user controls
- Coding assistant mode
- Basic image generation
- Automation v1 (5 connectors)
- Team workspace alpha
- Usage metering + subscriptions skeleton

Out-of-scope (defer):
- Full video generation suite
- Full music production suite
- Marketplace public launch
- Enterprise on-prem package

## Week-by-Week Plan
### Weeks 1-2: Foundation Sprint
Deliverables:
- Product requirements baseline and UX flows.
- Monorepo setup, CI/CD, environments (dev/stage/prod).
- Auth + workspace model + RBAC baseline.
- API gateway skeleton.
- Telemetry baseline (logs, traces, metrics).

Exit criteria:
- End-to-end login -> workspace creation -> chat shell working.
- Zero critical security findings in baseline review.

### Weeks 3-4: Orchestration + Memory Sprint
Deliverables:
- Agent orchestrator v1.
- Model router v1 (reasoning/coding/image profiles).
- Memory service v1 (save/retrieve/pin/forget).
- Prompt and context assembly pipeline.

Exit criteria:
- Contextual follow-up works across sessions.
- Memory controls are explicit and auditable.

### Weeks 5-6: Coding Mode + Files Sprint
Deliverables:
- Coding agent profile and toolset.
- File ingestion/indexing in projects.
- Code generation, explanation, and debug workflows.
- Artifact/version snapshots for generated outputs.

Exit criteria:
- Complete 10 scripted coding tasks with >=80% success.
- Regression suite for core coding operations.

### Weeks 7-8: Automation + Integrations Sprint
Deliverables:
- Workflow engine v1.
- Connectors: GitHub, Discord, Gmail/Outlook, Slack, Google Drive.
- Action permission prompts + policy checks.
- Job queue retry/idempotency framework.

Exit criteria:
- 20 canonical automations pass in staging.
- Replay/retry flow verified with audit logs.

### Weeks 9-10: Creator Features + Team Alpha Sprint
Deliverables:
- Image generation workflow and gallery.
- Team shared workspace and comments.
- Role controls for project actions.
- Usage dashboards (tokens/jobs/storage).

Exit criteria:
- Team collaboration scenarios validated.
- Image generation latency and cost within targets.

### Weeks 11-12: Hardening + Beta Launch Sprint
Deliverables:
- Performance optimization and reliability pass.
- Security hardening and key management review.
- Billing tier scaffolding (Free/Pro/Business).
- Beta onboarding and support playbook.
- Premium UX conformance pass (AI Core, motion, live-thinking, status transparency).

Exit criteria:
- Beta launch checklist complete.
- Incident response runbook tested.
- Production readiness review signed off.

## Premium Experience Track (Runs Across All 12 Weeks)
1. AI Core state engine
- Implement deterministic state transitions bound to real system events.
- Validate state accuracy during voice, tool, and response workflows.

2. Live Coding command center
- Ensure coding workflows stream actual command and file events.
- Reject releases that display simulated completion states.

3. Live Thinking transparency
- Show non-sensitive reasoning stages: understanding, gathering context, planning, building, verifying.
- Measure stage timing to improve user-perceived responsiveness.

4. Motion and rendering stability
- Enforce frame/latency budgets for nav, prompt interactions, and panel transitions.
- Include reduced-motion parity validation.

## Non-Negotiable Release Gates
- Gate A: Security and data integrity
	- No unresolved critical findings across auth, RBAC, idempotency, and audit logs.

- Gate B: Runtime truthfulness
	- Live Coding and execution status surfaces reflect real operations and logs.

- Gate C: Performance and fluidity
	- Interaction and rendering stay within predefined budgets on reference hardware.

- Gate D: Recovery and persistence
	- Restart, replay, and degraded-mode recovery tests pass for critical workflows.

## Parallel Workstreams
### Product and Design
- UX for workspace, memory controls, agent mode switching.
- Onboarding that teaches trust and control quickly.

### AI/ML
- Prompt templates and evaluation harness.
- Model routing quality/cost optimization.

### Platform/SRE
- SLO dashboards, alerting, autoscaling.
- Backup/restore and disaster recovery tests.

### QA
- Scenario-based E2E tests for core loop.
- Abuse and permission bypass tests.

## Risk Register and Mitigation
1. Scope explosion.
Mitigation: freeze Day-90 scope and enforce change control.

2. Memory trust issues.
Mitigation: transparent memory viewer + explicit remember/forget actions.

3. Connector fragility.
Mitigation: contract tests, retries, idempotency keys, dead-letter queue.

4. Model cost spikes.
Mitigation: routing guards, cached responses, async downgrade pathways.

5. Security incidents.
Mitigation: least privilege scopes, secrets vault, security reviews each sprint.

## Launch Readiness Checklist
- Auth/RBAC penetration checks passed.
- Data deletion/export workflow verified.
- Billing events reconcile with usage logs.
- On-call escalation flow validated.
- Post-launch metrics board live.

## Post-Day-90 Immediate Next Steps
- Add advanced voice assistant mode.
- Expand automation connectors and templates.
- Open API private beta.
- Begin plugin SDK developer preview.
