import { z } from "zod";
import { AppError } from "../../errors.js";
import { isValidTimeZone } from "../../domain/schemas.js";

/** Throws a 400 listing field paths + messages only (never echoes submitted values back). */
export function parseInput<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new AppError(400, "validation_error", detail.slice(0, 500));
  }
  return result.data;
}

const name = z.string().trim().min(1).max(120);
const email = z.string().trim().toLowerCase().max(320).pipe(z.email());
const timezone = z.string().max(64).refine(isValidTimeZone, "invalid IANA timezone");
const locale = z.string().regex(/^[a-z]{2}$|^[a-z]{2}-[A-Z]{2}$/, "invalid locale");

export const signupBody = z
  .strictObject({
    email,
    password: z.string().min(12, "must be at least 12 characters").max(128),
    name,
    restaurantName: name,
    timezone,
    currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code").default("USD"),
  })
  .refine((v) => v.password.toLowerCase() !== v.email, { path: ["password"], message: "must not equal the email" });

export const loginBody = z.strictObject({ email, password: z.string().min(1).max(128) });

export const restaurantPatchBody = z
  .strictObject({ name: name.optional(), timezone: timezone.optional(), defaultLocale: locale.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "at least one field is required");

export const widgetKeyBody = z.strictObject({
  allowedOrigins: z.array(z.string().max(200)).min(1).max(20),
  label: z.string().trim().min(1).max(80).optional(),
});

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.date().optional(),
});
