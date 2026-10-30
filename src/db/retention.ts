import type { Env } from "../config/env.js";
import type { Restaurant } from "../domain/schemas.js";

export type RetentionDefaults = Pick<
  Env,
  "RETENTION_MESSAGES_DAYS" | "RETENTION_CONVERSATIONS_DAYS" | "RETENTION_USAGE_MONTHS"
>;

const DAY_MS = 86_400_000;

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Resolves the expiry instants written into `expiresAt`. MongoDB's TTL monitor deletes the documents
 * (index with expireAfterSeconds: 0), so personal data is not kept indefinitely even if nobody runs a job.
 * A restaurant can only configure its own policy; platform defaults apply otherwise.
 */
export function retentionPolicy(defaults: RetentionDefaults, restaurant?: Pick<Restaurant, "retention">) {
  const r = restaurant?.retention ?? {};
  return {
    messageExpiry: (now: Date) => addDays(now, r.messagesDays ?? defaults.RETENTION_MESSAGES_DAYS),
    conversationExpiry: (now: Date) => addDays(now, r.conversationsDays ?? defaults.RETENTION_CONVERSATIONS_DAYS),
    usageExpiry: (now: Date) => addMonths(now, r.usageMonths ?? defaults.RETENTION_USAGE_MONTHS),
  };
}
