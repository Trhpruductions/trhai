import { query } from "../db.js";

export type IdempotentResponse = {
  statusCode: number;
  responseJson: unknown;
};

export async function findIdempotentResponse(
  workspaceId: string,
  routeKey: string,
  idempotencyKey: string
): Promise<IdempotentResponse | null> {
  const existing = await query<{ status_code: number; response_json: unknown }>(
    `
    SELECT status_code, response_json
    FROM idempotency_keys
    WHERE workspace_id = $1 AND route_key = $2 AND idempotency_key = $3
    LIMIT 1
    `,
    [workspaceId, routeKey, idempotencyKey]
  );

  if (!existing.rowCount || !existing.rows[0]) {
    return null;
  }

  return {
    statusCode: existing.rows[0].status_code,
    responseJson: existing.rows[0].response_json
  };
}

export async function saveIdempotentResponse(
  workspaceId: string,
  routeKey: string,
  idempotencyKey: string,
  statusCode: number,
  responseJson: unknown,
  createdBy?: string
): Promise<void> {
  await query(
    `
    INSERT INTO idempotency_keys (workspace_id, route_key, idempotency_key, status_code, response_json, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    ON CONFLICT (workspace_id, route_key, idempotency_key)
    DO NOTHING
    `,
    [workspaceId, routeKey, idempotencyKey, statusCode, JSON.stringify(responseJson), createdBy ?? null]
  );
}

export function readIdempotencyKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;
  return key;
}
