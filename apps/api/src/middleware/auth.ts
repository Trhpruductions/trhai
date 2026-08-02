import { NextFunction, Request, RequestHandler, Response } from "express";
import { jwtVerify } from "jose";

export type AuthIdentity = {
  subject: string;
  email?: string;
  name?: string;
  provider: "jwt" | "dev";
};

const authMode = (process.env.AUTH_MODE ?? "dev").toLowerCase();
const jwtSecret = process.env.AUTH_JWT_SECRET ?? "";
const jwtIssuer = process.env.AUTH_JWT_ISSUER;
const jwtAudience = process.env.AUTH_JWT_AUDIENCE;

function parseBearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  if (!token?.trim()) return null;
  return token.trim();
}

async function resolveIdentityFromJwt(req: Request): Promise<AuthIdentity | null> {
  const token = parseBearerToken(req);
  if (!token) return null;
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is required when AUTH_MODE=jwt");
  }

  const verification = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
    issuer: jwtIssuer || undefined,
    audience: jwtAudience || undefined
  });

  const claims = verification.payload;
  return {
    subject: typeof claims.sub === "string" ? claims.sub : "unknown",
    email: typeof claims.email === "string" ? claims.email.toLowerCase() : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
    provider: "jwt"
  };
}

function resolveIdentityFromDevHeaders(req: Request): AuthIdentity {
  const email = req.header("x-ascend-user-email")?.trim().toLowerCase();
  const name = req.header("x-ascend-user-name")?.trim();

  return {
    subject: email || "dev-user",
    email: email || process.env.DEV_USER_EMAIL || "owner@example.com",
    name: name || process.env.DEV_USER_DISPLAY_NAME || "Ascend Owner",
    provider: "dev"
  };
}

export function attachAuthIdentity(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (authMode === "jwt") {
        const identity = await resolveIdentityFromJwt(req);
        if (!identity) {
          res.status(401).json({ code: "UNAUTHORIZED", message: "Bearer token required", traceId: "trace-local" });
          return;
        }

        res.locals.identity = identity;
        next();
        return;
      }

      const jwtIdentity = await resolveIdentityFromJwt(req).catch(() => null);
      res.locals.identity = jwtIdentity ?? resolveIdentityFromDevHeaders(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}
