# Project Ascend AI / TRH AI
## Initial Data Schema and Service Contracts

Date: 2026-08-01
Status: Draft for implementation kickoff

## 1) Schema Design Goals
- Strong tenant/workspace isolation.
- Clear ownership and auditability.
- Idempotent side-effect handling.
- Efficient retrieval for assistant and memory flows.

## 2) Core Data Model (Logical)

### User
Fields:
- id (uuid, pk)
- email (unique)
- display_name
- auth_provider
- created_at
- updated_at
- status

### Team
Fields:
- id (uuid, pk)
- name
- owner_user_id (fk user.id)
- created_at
- updated_at

### Workspace
Fields:
- id (uuid, pk)
- team_id (fk team.id, nullable for personal)
- name
- slug (unique per team scope)
- plan_tier (free, pro, business, enterprise)
- region
- created_by
- created_at
- updated_at

### WorkspaceMember
Fields:
- id (uuid, pk)
- workspace_id (fk workspace.id)
- user_id (fk user.id)
- role (owner, admin, member, viewer, billing_admin, automation_operator)
- invited_by
- joined_at
- unique(workspace_id, user_id)

### Project
Fields:
- id (uuid, pk)
- workspace_id (fk workspace.id)
- name
- type (coding, business, creator, gaming, mixed)
- description
- created_by
- created_at
- updated_at

### Conversation
Fields:
- id (uuid, pk)
- workspace_id
- project_id (nullable)
- mode (general, coding, business, creator)
- title
- created_by
- created_at
- updated_at

### Message
Fields:
- id (uuid, pk)
- conversation_id (fk conversation.id)
- workspace_id
- role (user, assistant, system, tool)
- content_json
- token_input
- token_output
- model_name
- trace_id
- created_at

Indexes:
- idx_message_conversation_created (conversation_id, created_at)

### MemoryRecord
Fields:
- id (uuid, pk)
- workspace_id
- project_id (nullable)
- owner_scope (personal, workspace, team)
- source_type (conversation, file, workflow, manual)
- source_id
- title
- body
- embedding_ref
- confidence_score
- pinned (bool)
- locked (bool)
- created_by
- created_at
- updated_at
- deleted_at (soft delete)

Indexes:
- idx_memory_workspace_project (workspace_id, project_id)
- idx_memory_scope_created (owner_scope, created_at)

### Artifact
Fields:
- id (uuid, pk)
- workspace_id
- project_id
- kind (code_patch, image, video, audio, document, workflow_result)
- storage_uri
- checksum
- metadata_json
- created_by
- created_at

### Workflow
Fields:
- id (uuid, pk)
- workspace_id
- name
- version
- status (draft, active, paused, archived)
- definition_json
- created_by
- created_at
- updated_at
- unique(workspace_id, name, version)

### WorkflowRun
Fields:
- id (uuid, pk)
- workspace_id
- workflow_id
- trigger_type
- trigger_payload_json
- status (queued, running, success, failed, cancelled)
- started_at
- ended_at
- error_code
- error_message
- trace_id

Indexes:
- idx_workflowrun_workspace_status (workspace_id, status)
- idx_workflowrun_workflow_started (workflow_id, started_at)

### ConnectorAccount
Fields:
- id (uuid, pk)
- workspace_id
- provider (github, discord, slack, gmail, gdrive)
- account_label
- auth_state (active, expired, revoked)
- encrypted_credentials_ref
- scopes_json
- created_by
- created_at
- updated_at

### AuditEvent
Fields:
- id (uuid, pk)
- workspace_id
- actor_user_id
- actor_type (user, system, service)
- event_type
- target_type
- target_id
- payload_json
- created_at

Indexes:
- idx_audit_workspace_created (workspace_id, created_at)

### UsageEvent
Fields:
- id (uuid, pk)
- workspace_id
- user_id
- feature (chat, coding, image, video, music, automation, api)
- quantity
- unit (tokens, seconds, jobs, bytes, requests)
- cost_usd_micros
- trace_id
- created_at

Indexes:
- idx_usage_workspace_feature_created (workspace_id, feature, created_at)

### ApiKey
Fields:
- id (uuid, pk)
- workspace_id
- name
- key_hash
- scopes_json
- status (active, revoked)
- last_used_at
- created_by
- created_at

## 3) Data Access Guardrails
- Every query includes workspace_id predicate except global admin operations.
- Soft-delete aware reads for memory and artifacts.
- Row-level policies for tenant isolation where supported.

## 4) Event Model (Async)
Topics:
- assistant.requested
- assistant.completed
- memory.recorded
- workflow.run.started
- workflow.run.completed
- usage.event.captured
- audit.event.created

Event contract base:
- event_id
- event_type
- workspace_id
- trace_id
- occurred_at
- payload

## 5) API Contract Principles
- REST for control plane resources.
- Server-sent events or websocket for streaming assistant responses.
- Idempotency-Key required for side-effect POST endpoints.
- Standard error envelope with machine-readable codes.

Error envelope:
- code
- message
- details
- trace_id

## 6) Service API Draft (v1)

### Auth and Workspace
1. POST /v1/workspaces
Request:
- name
- team_id (optional)

Response:
- workspace_id
- slug
- role

2. POST /v1/workspaces/{workspaceId}/invites
Request:
- email
- role

Response:
- invite_id
- expires_at

3. GET /v1/workspaces/{workspaceId}/members
Response:
- members[]

### Conversations and Assistant
1. POST /v1/workspaces/{workspaceId}/conversations
Request:
- project_id (optional)
- mode
- title (optional)

Response:
- conversation_id

2. POST /v1/workspaces/{workspaceId}/conversations/{conversationId}/messages
Headers:
- Idempotency-Key (required for tool actions)

Request:
- content
- mode_override (optional)
- stream (bool)

Response (non-stream):
- message_id
- assistant_message
- artifacts[]
- usage

Streaming response events:
- message.started
- message.delta
- tool.call.started
- tool.call.completed
- message.completed
- message.error

3. GET /v1/workspaces/{workspaceId}/conversations/{conversationId}
Response:
- conversation
- messages[]

### Memory
1. GET /v1/workspaces/{workspaceId}/memory
Query:
- project_id
- scope
- q
- page
- page_size

Response:
- items[]
- pagination

2. POST /v1/workspaces/{workspaceId}/memory/{memoryId}/pin
Response:
- memory_id
- pinned

3. POST /v1/workspaces/{workspaceId}/memory/{memoryId}/forget
Response:
- memory_id
- deleted_at

4. POST /v1/workspaces/{workspaceId}/memory/export
Response:
- export_job_id

### Projects and Artifacts
1. POST /v1/workspaces/{workspaceId}/projects
2. GET /v1/workspaces/{workspaceId}/projects
3. GET /v1/workspaces/{workspaceId}/artifacts/{artifactId}
4. POST /v1/workspaces/{workspaceId}/artifacts

### Workflows and Automation
1. POST /v1/workspaces/{workspaceId}/workflows
2. POST /v1/workspaces/{workspaceId}/workflows/{workflowId}/activate
3. POST /v1/workspaces/{workspaceId}/workflows/{workflowId}/runs
Headers:
- Idempotency-Key required

4. GET /v1/workspaces/{workspaceId}/workflows/{workflowId}/runs

### Connectors
1. POST /v1/workspaces/{workspaceId}/connectors/{provider}/connect
2. GET /v1/workspaces/{workspaceId}/connectors
3. POST /v1/workspaces/{workspaceId}/connectors/{connectorId}/revoke

### Billing and Usage
1. GET /v1/workspaces/{workspaceId}/usage
2. GET /v1/workspaces/{workspaceId}/plans
3. POST /v1/workspaces/{workspaceId}/plans/change

### API Keys
1. POST /v1/workspaces/{workspaceId}/api-keys
2. GET /v1/workspaces/{workspaceId}/api-keys
3. POST /v1/workspaces/{workspaceId}/api-keys/{apiKeyId}/revoke

## 7) Example Response Schemas

### Standard success envelope
- data
- meta
- trace_id

### Pagination meta
- page
- page_size
- total
- has_next

## 8) Versioning and Compatibility
- URI versioning: /v1
- Non-breaking additions allowed in minor updates.
- Breaking changes require /v2 and migration guide.

## 9) Security Requirements at Contract Level
- RBAC checked for every route.
- Workspace boundary checks mandatory.
- Rate limit by key and user.
- Audit events for write operations.

## 10) Implementation Order
1. Auth/workspace/member APIs.
2. Conversations/messages streaming API.
3. Memory APIs.
4. Project/artifact APIs.
5. Workflow and connector APIs.
6. Usage, plans, and API keys.
