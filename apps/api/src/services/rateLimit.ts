// Sliding-window rate limiting for authentication.
//
// Without this, `/v1/auth/login` accepts unlimited guesses and passwords are
// brute-forceable at network speed. In-process and standard library only, which
// is the right scope here: this API runs as a single process, and a limiter that
// needs Redis would be a dependency bought for a problem we do not have yet.

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

export type RateLimitRule = {
  /** Attempts permitted inside the window. */
  limit: number;
  windowMs: number;
};

type Bucket = {
  /** Timestamps of counted attempts, oldest first. */
  hits: number[];
};

const buckets = new Map<string, Bucket>();

/** Stop the map growing without bound when keys are never seen again. */
const maxTrackedKeys = 10_000;

function prune(bucket: Bucket, now: number, windowMs: number): void {
  while (bucket.hits.length > 0 && now - bucket.hits[0] > windowMs) {
    bucket.hits.shift();
  }
}

function evictIfNeeded(): void {
  while (buckets.size > maxTrackedKeys) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}

/**
 * Check a key without consuming an attempt. Used to reject early so a locked-out
 * caller does not get a password comparison done on their behalf.
 */
export function checkRateLimit(key: string, rule: RateLimitRule, now = Date.now()): RateLimitDecision {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true, remaining: rule.limit };

  prune(bucket, now, rule.windowMs);
  if (bucket.hits.length < rule.limit) {
    return { allowed: true, remaining: rule.limit - bucket.hits.length };
  }

  const oldest = bucket.hits[0];
  const retryAfterMs = rule.windowMs - (now - oldest);
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
}

/** Record one failed attempt against a key. */
export function recordFailure(key: string, rule: RateLimitRule, now = Date.now()): void {
  const bucket = buckets.get(key) ?? { hits: [] };
  prune(bucket, now, rule.windowMs);
  bucket.hits.push(now);
  buckets.set(key, bucket);
  evictIfNeeded();
}

/** A success wipes the record, so normal users never accumulate toward a lockout. */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}

export function trackedKeyCount(): number {
  return buckets.size;
}

// Two different jobs, so two different rules.
//
// The IP rule is the real brute-force defence and is deliberately strict.
//
// The email rule is looser and its window is short on purpose: locking an account
// hard on failed attempts lets anyone lock a user out of their own account just by
// guessing wrong at them. A brief throttle slows credential-stuffing without
// handing an attacker a denial-of-service primitive.
export const loginIpRule: RateLimitRule = { limit: 10, windowMs: 5 * 60 * 1000 };
export const loginEmailRule: RateLimitRule = { limit: 5, windowMs: 60 * 1000 };
// Signup is capped generously: a whole team can share one egress IP, and locking
// out real signups is a worse outcome than tolerating a slow trickle of spam.
export const registerIpRule: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 };
// Changing a password requires the current one, so this endpoint is another way
// to guess it. Keyed by account rather than IP: the caller is already known.
export const passwordChangeRule: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };
// Recovery is unauthenticated and grants a password reset, so it is the most
// attractive endpoint to attack. Tighter than login.
export const recoveryIpRule: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };
export const recoveryEmailRule: RateLimitRule = { limit: 5, windowMs: 15 * 60 * 1000 };

/** Normalized client address for keying. Falls back to a constant when unknown. */
export function clientKey(ip: unknown): string {
  return typeof ip === "string" && ip.trim() ? ip.trim() : "unknown-client";
}
