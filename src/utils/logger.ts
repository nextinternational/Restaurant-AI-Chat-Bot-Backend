import pino, { type Logger } from "pino";
import type { Env } from "../config/env.js";

/**
 * Structured JSON logs. Sensitive fields are redacted so tokens and personal data
 * never reach CloudWatch. Never log message bodies or customer PII.
 */
export function createLogger(env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-session-token"]',
        'req.headers["x-widget-key"]',
        'res.headers["set-cookie"]',
        "*.token",
        "*.sessionToken",
        "*.password",
        "*.apiKey",
        "*.email",
        "*.phone",
      ],
      censor: "[REDACTED]",
    },
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}
