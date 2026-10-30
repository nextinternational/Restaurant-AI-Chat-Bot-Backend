import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { ROLES, type Role } from "../auth/permissions.js";
import { AppError } from "../errors.js";
import { parseRestaurantId, type RestaurantId } from "../domain/ids.js";
import { isValidTimeZone, type User } from "../domain/schemas.js";
import { normalizeOrigin, slugify } from "../domain/slug.js";
import { generatePrefixedId } from "../security/tokens.js";
import { hashPasswordAsync } from "../security/passwords.js";
import { EmailTakenError, MembershipExistsError, SlugTakenError, type AccountStore, type RestaurantSettingsPatch } from "../repositories/accountStore.js";

const text = z.string().trim().min(1).max(120);
const email = z.string().trim().toLowerCase().max(320).pipe(z.email());
const password = z.string().min(12, "must be at least 12 characters").max(128);
const slugValue = z
  .string()
  .max(64)
  .regex(/^[a-z0-9-]+$/, "lowercase letters, digits and hyphens only")
  .refine((v) => !v.startsWith("-") && !v.endsWith("-") && !v.includes("--"), "invalid slug"); // linear check, no ReDoS-prone regex

export const provisionRestaurantInput = z.strictObject({
  name: text,
  slug: slugValue.optional(),
  timezone: z.string().max(64).refine(isValidTimeZone, "invalid IANA timezone"),
  currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code").default("USD"),
  locale: z.string().regex(/^[a-z]{2}$|^[a-z]{2}-[A-Z]{2}$/, "invalid locale").default("en"),
  ownerEmail: email,
  ownerName: text,
  ownerPassword: password.optional(),
  origins: z.array(z.string().max(200)).max(20).default([]),
});
export type ProvisionRestaurantInput = z.input<typeof provisionRestaurantInput>;

export const addStaffInput = z.strictObject({
  restaurantSlug: slugValue,
  email,
  name: text,
  role: z.enum(ROLES).default("staff"),
  password: password.optional(),
});
export type AddStaffInput = z.input<typeof addStaffInput>;

export const restaurantSettingsInput = z.strictObject({
  restaurantSlug: slugValue,
  address: z.string().trim().min(1).max(300).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  mapUrl: z.url().max(300).optional(),
  notes: z.string().trim().min(1).max(300).optional(),
  /** Monthly AI spend cap in USD (0 = platform default). */
  monthlyAiBudgetUsd: z.number().min(0).max(10_000).optional(),
});
export type RestaurantSettingsInput = z.input<typeof restaurantSettingsInput>;

export interface ProvisionedUser {
  userId: string;
  email: string;
  /** false when the email already belonged to a user: they were attached, their password was NOT touched. */
  created: boolean;
  /** Present only when the service generated it. Shown once by the CLI; never stored in clear text. */
  generatedPassword?: string;
}

export interface ProvisionRestaurantResult {
  restaurantId: RestaurantId;
  slug: string;
  owner: ProvisionedUser;
  widgetKeys: { publicKey: string; allowedOrigins: string[] }[];
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new AppError(400, "validation_error", detail.slice(0, 500));
  }
  return r.data;
}

/**
 * Operator-only onboarding for a fixed set of restaurants. There is deliberately NO HTTP surface:
 * only the CLI (src/scripts/provision.ts) reaches this, so nothing public can create tenants or staff.
 */
export class ProvisioningService {
  constructor(
    private readonly store: AccountStore,
    private readonly opts: { allowInsecureLocalhostOrigins: boolean },
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async provisionRestaurant(raw: ProvisionRestaurantInput): Promise<ProvisionRestaurantResult> {
    const input = parse(provisionRestaurantInput, raw);
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw new AppError(400, "validation_error", "slug: required when the name has no Latin letters (use --slug)");
    const origins = this.normalizeOrigins(input.origins);

    const now = this.clock();
    const restaurantId = parseRestaurantId(generatePrefixedId("rest_"));
    const owner = await this.resolveUser(input.ownerEmail, input.ownerName, input.ownerPassword, now);

    try {
      await this.store.provisionRestaurant({
        ...(owner.newUser ? { user: owner.newUser } : {}),
        restaurant: {
          restaurantId, slug, name: input.name, status: "active", timezone: input.timezone, currency: input.currency,
          defaultLocale: input.locale, retention: {}, monthlyAiBudgetMicros: 0, createdAt: now, updatedAt: now,
        },
        membership: { userId: owner.summary.userId, restaurantId, role: "owner", status: "active", createdAt: now, updatedAt: now },
      });
    } catch (err) {
      if (err instanceof SlugTakenError) throw new AppError(409, "slug_taken", `Restaurant slug "${slug}" is already in use`);
      if (err instanceof EmailTakenError) throw new AppError(409, "email_taken", "Owner email was registered concurrently; run again");
      throw err;
    }

    const widgetKeys: ProvisionRestaurantResult["widgetKeys"] = [];
    if (origins.length > 0) {
      const key = await this.store.createWidgetKey(restaurantId, { allowedOrigins: origins, label: "provisioned" }, now);
      widgetKeys.push({ publicKey: key.publicKey, allowedOrigins: key.allowedOrigins });
    }
    await this.audit(restaurantId, owner.summary.userId, "restaurant.provisioned", "restaurant", restaurantId, { via: "cli", ownerCreated: owner.summary.created }, now);
    return { restaurantId, slug, owner: owner.summary, widgetKeys };
  }

  /** Sets the restaurant's address, contact phone number and map link, and the AI cap. Merges with existing values. */
  async updateSettings(raw: RestaurantSettingsInput): Promise<{ restaurantId: RestaurantId; changed: string[] }> {
    const input = parse(restaurantSettingsInput, raw);
    const restaurant = await this.store.findRestaurantBySlug(input.restaurantSlug);
    if (!restaurant) throw new AppError(404, "not_found", `No restaurant with slug "${input.restaurantSlug}"`);

    const patch: RestaurantSettingsPatch = {};
    const changed: string[] = [];
    if (input.address !== undefined || input.phone !== undefined || input.mapUrl !== undefined || input.notes !== undefined) {
      const merged = {
        ...(restaurant.location ?? {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.mapUrl !== undefined ? { mapUrl: input.mapUrl } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };
      if (!merged.address) throw new AppError(400, "validation_error", "address: required the first time location is set");
      patch.location = merged as NonNullable<RestaurantSettingsPatch["location"]>;
      changed.push("location");
    }
    if (input.monthlyAiBudgetUsd !== undefined) {
      patch.monthlyAiBudgetMicros = Math.round(input.monthlyAiBudgetUsd * 1_000_000);
      changed.push("monthlyAiBudgetMicros");
    }
    if (changed.length === 0) throw new AppError(400, "validation_error", "nothing to update: pass at least one setting");

    const now = this.clock();
    await this.store.updateRestaurantSettings(restaurant.restaurantId, patch, now);
    await this.store.recordAudit(restaurant.restaurantId, { action: "restaurant.settings_updated", resourceType: "restaurant", resourceId: restaurant.restaurantId, metadata: { via: "cli", fields: changed } }, now);
    return { restaurantId: restaurant.restaurantId, changed };
  }

  async addStaff(raw: AddStaffInput): Promise<{ restaurantId: RestaurantId; user: ProvisionedUser; role: Role }> {
    const input = parse(addStaffInput, raw);
    const restaurant = await this.store.findRestaurantBySlug(input.restaurantSlug);
    if (!restaurant) throw new AppError(404, "not_found", `No restaurant with slug "${input.restaurantSlug}"`);

    const now = this.clock();
    const u = await this.resolveUser(input.email, input.name, input.password, now);
    try {
      await this.store.addMember({
        ...(u.newUser ? { user: u.newUser } : {}),
        membership: { userId: u.summary.userId, restaurantId: restaurant.restaurantId, role: input.role, status: "active", createdAt: now, updatedAt: now },
      });
    } catch (err) {
      if (err instanceof MembershipExistsError) throw new AppError(409, "already_member", "This user already belongs to the restaurant");
      if (err instanceof EmailTakenError) throw new AppError(409, "email_taken", "Email was registered concurrently; run again");
      throw err;
    }
    await this.audit(restaurant.restaurantId, u.summary.userId, "staff.provisioned", "membership", u.summary.userId, { via: "cli", role: input.role }, now);
    return { restaurantId: restaurant.restaurantId, user: u.summary, role: input.role };
  }

  // ------------------------------------------------------------------ internals
  private normalizeOrigins(raw: string[]): string[] {
    const out = new Set<string>();
    for (const o of raw) {
      const n = normalizeOrigin(o, this.opts.allowInsecureLocalhostOrigins);
      if (!n) throw new AppError(400, "invalid_origin", `Invalid origin "${o.slice(0, 80)}": use a bare https origin such as https://example.com`);
      out.add(n);
    }
    return [...out];
  }

  /** Existing email => attach that user (password untouched). New email => create with the given or a generated password. */
  private async resolveUser(emailAddr: string, name: string, pw: string | undefined, now: Date): Promise<{ summary: ProvisionedUser; newUser?: User }> {
    const existing = await this.store.findUserByEmail(emailAddr);
    if (existing) {
      if (existing.status !== "active") throw new AppError(409, "user_inactive", "That user exists but is not active");
      return { summary: { userId: existing.userId, email: existing.email, created: false } };
    }
    const generatedPassword = pw ? undefined : randomBytes(18).toString("base64url"); // 144 bits, 24 chars
    const passwordHash = await hashPasswordAsync(pw ?? generatedPassword!);
    const userId = generatePrefixedId("usr_");
    const newUser: User = { userId, email: emailAddr, name, passwordHash, status: "active", createdAt: now, updatedAt: now };
    return { newUser, summary: { userId, email: emailAddr, created: true, ...(generatedPassword ? { generatedPassword } : {}) } };
  }

  private async audit(restaurantId: RestaurantId, actorUserId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>, now: Date) {
    try {
      await this.store.recordAudit(restaurantId, { actorUserId, action, resourceType, resourceId, metadata }, now);
    } catch (err) {
      this.logger.error({ err, restaurantId }, "failed to write provisioning audit log"); // never fail a successful provisioning for one audit line
    }
  }
}
