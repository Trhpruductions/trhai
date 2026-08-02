import { AuthIdentity } from "./middleware/auth.js";

declare global {
  namespace Express {
    interface Locals {
      identity?: AuthIdentity;
      actor?: {
        userId: string;
        role: "owner" | "admin" | "member" | "viewer" | "billing_admin" | "automation_operator";
        email?: string;
        displayName?: string;
      };
    }
  }
}

export {};
