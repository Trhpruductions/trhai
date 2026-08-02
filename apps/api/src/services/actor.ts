import { Request } from "express";
import { PoolClient } from "pg";
import { withTransaction } from "../db.js";

const fallbackEmail = process.env.DEV_USER_EMAIL ?? "owner@example.com";
const fallbackDisplayName = process.env.DEV_USER_DISPLAY_NAME ?? "Ascend Owner";

export type ActorContext = {
  userId: string;
  email: string;
  displayName: string;
};

function resolveActorIdentity(req: Request): { email: string; displayName: string } {
  const identity = req.res?.locals.identity;
  if (identity?.email) {
    return {
      email: identity.email.toLowerCase(),
      displayName: identity.name && identity.name.length > 1 ? identity.name : fallbackDisplayName
    };
  }

  const headerEmail = req.header("x-ascend-user-email")?.trim();
  const headerDisplayName = req.header("x-ascend-user-name")?.trim();

  return {
    email: headerEmail && headerEmail.length > 3 ? headerEmail.toLowerCase() : fallbackEmail,
    displayName: headerDisplayName && headerDisplayName.length > 1 ? headerDisplayName : fallbackDisplayName
  };
}

export async function ensureActorUserWithClient(client: PoolClient, req: Request): Promise<ActorContext> {
  const identity = resolveActorIdentity(req);

  const existing = await client.query<{ id: string; email: string; display_name: string }>(
    "SELECT id, email, display_name FROM users WHERE email = $1",
    [identity.email]
  );

  if (existing.rowCount && existing.rows[0]) {
    return {
      userId: existing.rows[0].id,
      email: existing.rows[0].email,
      displayName: existing.rows[0].display_name
    };
  }

  const inserted = await client.query<{ id: string; email: string; display_name: string }>(
    `
    INSERT INTO users (email, display_name, auth_provider)
    VALUES ($1, $2, $3)
    RETURNING id, email, display_name
    `,
    [identity.email, identity.displayName, "header-dev"]
  );

  return {
    userId: inserted.rows[0].id,
    email: inserted.rows[0].email,
    displayName: inserted.rows[0].display_name
  };
}

export async function ensureActorUserFromRequest(req: Request): Promise<ActorContext> {
  return withTransaction(async (client) => ensureActorUserWithClient(client, req));
}
