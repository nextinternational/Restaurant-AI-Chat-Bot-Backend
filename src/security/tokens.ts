import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits from the OS CSPRNG, URL-safe. Used for conversation session tokens. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** `wk_` + 32 URL-safe chars (192 bits). Public identifier, not a secret. */
export function generateWidgetKey(): string {
  return `wk_${randomBytes(24).toString("base64url")}`;
}

/**
 * Tokens are 256-bit random values, so a fast hash is appropriate (slow password hashes protect
 * low-entropy secrets). Only this hash is persisted: a database leak does not leak usable sessions.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}


/**
 * Random opaque identifier for server-side SaaS records: 128 bits as lower-case hex, so it always
 * satisfies the `^rest_[a-z0-9]{1,32}$` / `^usr_[a-z0-9_-]{8,40}$` validators (base64url can emit
 * `-` and `_`, which the tenant-id pattern forbids).
 */
export function generatePrefixedId(prefix: "usr_" | "rest_"): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

/** API keys are shown once; only their SHA-256 hash is persisted. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const raw = randomBytes(24).toString("base64url");
  const key = `rk_${raw}`;
  return { key, prefix: `rk_${raw.slice(0, 8)}`, hash: hashToken(key) };
}
