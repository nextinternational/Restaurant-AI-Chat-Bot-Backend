import { z } from "zod";

/** `KEY=` in a .env file or compose file means "not set", not "set to an empty string". */
const optionalString = (min = 1, max = 4096) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().min(min).max(max).optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,38}$/, "must be 1-38 chars: letters, digits, _ or -"),

  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(120),

  // Accounts & sessions (Step 4)
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  AUTH_RATE_LIMIT_PER_15MIN: z.coerce.number().int().min(1).default(20),
  LOGIN_RATE_LIMIT_PER_EMAIL_15MIN: z.coerce.number().int().min(1).default(10),
  // Menu / hours management (Step 7): mutating requests allowed per staff user per minute.
  ADMIN_WRITE_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(60),
  DEFAULT_PLAN_CODE: z.string().regex(/^[a-z0-9-]{1,40}$/).default("starter"),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14),

  // Public self-service signup is OFF: restaurants are created by the operator (npm run provision:restaurant).
  ALLOW_PUBLIC_SIGNUP: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),

  // AI chat (Step 6). Without OPENAI_API_KEY the public chat API is not mounted.
  OPENAI_API_KEY: optionalString(),
  OPENAI_MODEL: z.string().min(1).max(80).default("gpt-4o-mini"),
  /** Micro-USD per 1M tokens. Verify against your provider's current price list. */
  AI_INPUT_COST_MICROS_PER_MTOK: z.coerce.number().int().min(0).default(150_000),
  AI_OUTPUT_COST_MICROS_PER_MTOK: z.coerce.number().int().min(0).default(600_000),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
  /** Used when a restaurant has no monthlyAiBudgetMicros of its own (0). 10_000_000 = 10 USD. */
  AI_DEFAULT_MONTHLY_BUDGET_MICROS: z.coerce.number().int().min(0).default(10_000_000),

  // Public chat abuse limits (in-memory, per container).
  CHAT_SESSIONS_PER_IP_HOUR: z.coerce.number().int().min(1).default(20),
  CHAT_SESSIONS_PER_KEY_HOUR: z.coerce.number().int().min(1).default(300),
  CHAT_MESSAGES_PER_SESSION_MIN: z.coerce.number().int().min(1).default(12),
  CHAT_MESSAGES_PER_KEY_MIN: z.coerce.number().int().min(1).default(120),
  /** A chat session unused for this long is refused. 0 disables the check. */
  CHAT_SESSION_IDLE_HOURS: z.coerce.number().int().min(0).max(24 * 30).default(12),
  CHAT_MAX_MESSAGES_PER_CONVERSATION: z.coerce.number().int().min(2).default(100),

  // Default retention (days / months). A restaurant may override these (see restaurants.retention).
  RETENTION_MESSAGES_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_CONVERSATIONS_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  RETENTION_USAGE_MONTHS: z.coerce.number().int().min(1).max(120).default(13),
});

export type Env = z.infer<typeof schema>;

function isLocalMongo(uri: string): boolean {
  if (!uri.startsWith("mongodb://")) return false;
  const authority = uri.slice("mongodb://".length).split(/[/?]/, 1)[0] ?? "";
  const hosts = authority.slice(authority.lastIndexOf("@") + 1).split(",");
  return hosts.some((h) => /^(localhost|127\.|\[?::1\]?)/i.test(h));
}

/** Fail fast: the process refuses to boot with a missing or invalid configuration. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Only field names + messages are reported, never the submitted values (they may be secrets).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    const uri = env.MONGODB_URI;
    if (isLocalMongo(uri)) {
      throw new Error("Invalid environment configuration: production cannot use a localhost MongoDB");
    }
    const tlsEnabled = uri.startsWith("mongodb+srv://") || /[?&]tls=true(&|$)/i.test(uri);
    if (!tlsEnabled) {
      throw new Error("Invalid environment configuration: production MongoDB connection must use TLS");
    }
    if (/[?&]tls(AllowInvalid(Certificates|Hostnames)|Insecure)=true/i.test(uri)) {
      throw new Error("Invalid environment configuration: TLS certificate validation cannot be disabled");
    }
    if (env.CORS_ALLOWED_ORIGINS.includes("*")) {
      throw new Error("Invalid environment configuration: wildcard CORS origin is forbidden in production");
    }
    if (env.TRUST_PROXY_HOPS < 1) {
      // Behind the ALB every request would otherwise appear to come from the ALB's IP,
      // which makes per-IP rate limiting useless and audit logs wrong.
      throw new Error("Invalid environment configuration: TRUST_PROXY_HOPS must be >= 1 in production (behind the ALB)");
    }
  }
  return env;
}
