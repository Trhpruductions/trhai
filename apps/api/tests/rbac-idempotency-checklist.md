# RBAC + Idempotency Integration Checklist

Use this checklist to validate protected routes in staging.

## Preconditions
- Apply migrations 001 and 002.
- Start API and DB.
- Create at least one workspace.

## RBAC Checks
1. Call GET /v1/workspaces/{workspaceId}/usage as member.
- Expected: 403 FORBIDDEN.

2. Call GET /v1/workspaces/{workspaceId}/conversations as viewer.
- Expected: 200 success.

3. Call POST /v1/workspaces/{workspaceId}/workflows as viewer.
- Expected: 403 FORBIDDEN.

## Idempotency Checks
1. POST /v1/workspaces/{workspaceId}/conversations/{conversationId}/messages without Idempotency-Key.
- Expected: 400 IDEMPOTENCY_KEY_REQUIRED.

2. POST same message twice with identical Idempotency-Key.
- Expected: second response returns same payload as first.

3. POST /v1/workspaces/{workspaceId}/workflows/{workflowId}/runs twice with identical Idempotency-Key.
- Expected: second response is replay from idempotency store.

## Auth Mode Checks
1. Set AUTH_MODE=jwt and omit Authorization header.
- Expected: 401 UNAUTHORIZED.

2. Set AUTH_MODE=jwt with valid token and member role.
- Expected: routes behave according to role rules.
