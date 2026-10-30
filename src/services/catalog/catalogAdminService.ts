import { AppError } from "../../errors.js";
import type { RestaurantId } from "../../domain/ids.js";
import { assertAllergensCompatible, normalizeAllergens, normalizeHours, type HoursInput, type MenuItemPatch } from "../../domain/catalogRules.js";
import { slugify } from "../../domain/slug.js";
import type { Allergen, MenuItem, OpeningHours } from "../../domain/schemas.js";
import type { AccountStore } from "../../repositories/accountStore.js";
import type { CatalogGateway, CatalogTenantContext } from "./gateway.js";

const notFound = () => new AppError(404, "not_found", "Resource not found");

export interface NewItemInput {
  name: string;
  slug?: string;
  description?: string;
  category: string;
  priceCents: number;
  available: boolean;
  dietaryTags: MenuItem["dietaryTags"];
}

/** What staff see. Never contains the tenant id; allergens are shown WITH their verification state. */
export function toAdminItem(i: MenuItem) {
  return {
    slug: i.slug, name: i.name, description: i.description ?? null, category: i.category,
    priceCents: i.priceCents, currency: i.currency, status: i.status, available: i.available, dietaryTags: i.dietaryTags,
    allergens: { declared: i.allergens, verified: i.allergensVerified, verifiedAt: i.allergensVerifiedAt ?? null, verifiedBy: i.allergensVerifiedBy ?? null },
    createdAt: i.createdAt, updatedAt: i.updatedAt,
  };
}
export type AdminItem = ReturnType<typeof toAdminItem>;

export function toAdminHours(h: Pick<OpeningHours, "weekly" | "exceptions"> & { updatedAt: Date }) {
  return { weekly: h.weekly, exceptions: h.exceptions, updatedAt: h.updatedAt };
}

/**
 * Staff-side management of menu items, allergen verification and opening hours.
 * `restaurantId` must be the server-verified one from `requireTenant`; actor ids come from the session, never the body.
 * Every mutation is audited. Nothing here is reachable by the AI model or the public widget.
 */
export class CatalogAdminService {
  constructor(
    private readonly gateway: CatalogGateway,
    private readonly store: Pick<AccountStore, "recordAudit" | "findUserById">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async ctx(restaurantId: RestaurantId): Promise<CatalogTenantContext> {
    const t = await this.gateway.tenantContext(restaurantId);
    if (!t) throw notFound();
    return t;
  }

  private audit(restaurantId: RestaurantId, actorUserId: string, action: string, resourceType: string, resourceId: string | undefined, metadata: Record<string, unknown>, now: Date) {
    return this.store.recordAudit(restaurantId, { actorUserId, action, resourceType, ...(resourceId !== undefined ? { resourceId } : {}), metadata }, now);
  }

  /**
   * Two ACTIVE items with the same normalised name would make "how much is the salmon?" ambiguous for the
   * assistant (it would have to hand off), so the API refuses to create that state in the first place.
   */
  private async assertNameFree(t: CatalogTenantContext, name: string, exceptSlug?: string): Promise<void> {
    const clash = (await t.menu.findByName(name)).find((m) => m.slug !== exceptSlug);
    if (clash) throw new AppError(409, "duplicate_name", "Another active menu item already has this name");
  }

  // ------------------------------------------------------------------ menu
  async listItems(restaurantId: RestaurantId, q: { status: "active" | "archived" | "all"; category?: string; after?: string; limit: number }) {
    const t = await this.ctx(restaurantId);
    const rows = await t.menu.listForAdmin({ ...q, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    return { items: page.map(toAdminItem), nextCursor: rows.length > q.limit ? page[page.length - 1]!.slug : null };
  }

  async getItem(restaurantId: RestaurantId, slug: string): Promise<AdminItem> {
    const item = await (await this.ctx(restaurantId)).menu.findAnyBySlug(slug);
    if (!item) throw notFound();
    return toAdminItem(item);
  }

  async createItem(restaurantId: RestaurantId, actorUserId: string, input: NewItemInput): Promise<AdminItem> {
    const t = await this.ctx(restaurantId);
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw new AppError(400, "slug_required", "Provide an explicit slug (the name has no Latin letters or digits to derive one from)");
    await this.assertNameFree(t, input.name);
    const now = this.clock();
    await t.menu.create(
      {
        slug, name: input.name, category: input.category, priceCents: input.priceCents, currency: t.restaurant.currency,
        status: "active", available: input.available, dietaryTags: [...new Set(input.dietaryTags)],
        // New items start UNVERIFIED. Allergen data only ever enters through the attested verification flow.
        allergens: [], allergensVerified: false,
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      now,
    );
    const created = await t.menu.findAnyBySlug(slug);
    if (!created) throw new Error("menu item vanished after create");
    await this.audit(restaurantId, actorUserId, "menu_item.created", "menu_item", slug, { priceCents: input.priceCents }, now);
    return toAdminItem(created);
  }

  async updateItem(restaurantId: RestaurantId, actorUserId: string, slug: string, patch: MenuItemPatch): Promise<AdminItem> {
    const t = await this.ctx(restaurantId);
    const before = await t.menu.findAnyBySlug(slug);
    if (!before) throw notFound();
    if (patch.name !== undefined && before.status === "active") await this.assertNameFree(t, patch.name, slug);
    const now = this.clock();
    const result = await t.menu.update(slug, patch, now);
    if (!result) throw notFound();
    if (result.changed.length > 0) {
      await this.audit(restaurantId, actorUserId, "menu_item.updated", "menu_item", slug, {
        fields: result.changed,
        ...(result.changed.includes("priceCents") ? { priceCents: { from: before.priceCents, to: result.item.priceCents } } : {}),
        ...(result.changed.includes("name") ? { name: { from: before.name, to: result.item.name } } : {}),
      }, now);
    }
    return toAdminItem(result.item);
  }

  /** Soft delete: the assistant stops seeing the item, history and audit references stay valid. Idempotent. */
  async archiveItem(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<void> {
    const t = await this.ctx(restaurantId);
    const item = await t.menu.findAnyBySlug(slug);
    if (!item) throw notFound();
    if (item.status === "archived") return;
    const now = this.clock();
    await t.menu.setStatus(slug, "archived", now);
    await this.audit(restaurantId, actorUserId, "menu_item.archived", "menu_item", slug, {}, now);
  }

  async restoreItem(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<AdminItem> {
    const t = await this.ctx(restaurantId);
    const item = await t.menu.findAnyBySlug(slug);
    if (!item) throw notFound();
    if (item.status === "active") return toAdminItem(item);
    await this.assertNameFree(t, item.name, slug);
    const now = this.clock();
    await t.menu.setStatus(slug, "active", now);
    await this.audit(restaurantId, actorUserId, "menu_item.restored", "menu_item", slug, {}, now);
    return toAdminItem({ ...item, status: "active", updatedAt: now });
  }

  // ------------------------------------------------------------------ allergens
  /**
   * The ONLY way an allergen declaration becomes usable by the assistant. The verifier identity is taken from the
   * authenticated user, not from the request body, so it cannot be spoofed or left blank.
   */
  async verifyAllergens(restaurantId: RestaurantId, actorUserId: string, slug: string, allergens: readonly Allergen[]): Promise<AdminItem> {
    const t = await this.ctx(restaurantId);
    const item = await t.menu.findAnyBySlug(slug);
    if (!item) throw notFound();
    const declared = normalizeAllergens(allergens);
    assertAllergensCompatible(item, declared);

    const user = await this.store.findUserById(actorUserId);
    const verifiedBy = `${(user?.name ?? "unknown").slice(0, 70)} (${actorUserId})`;
    const now = this.clock();
    await t.menu.setAllergens(slug, declared, verifiedBy, now);
    await this.audit(restaurantId, actorUserId, "menu_item.allergens_verified", "menu_item", slug, {
      from: { allergens: item.allergens, verified: item.allergensVerified }, to: { allergens: declared, verified: true },
    }, now);
    const after = await t.menu.findAnyBySlug(slug);
    if (!after) throw notFound();
    return toAdminItem(after);
  }

  /** E.g. the recipe changed: the assistant must stop answering allergen questions for this item until re-verified. */
  async revokeAllergenVerification(restaurantId: RestaurantId, actorUserId: string, slug: string): Promise<AdminItem> {
    const t = await this.ctx(restaurantId);
    const item = await t.menu.findAnyBySlug(slug);
    if (!item) throw notFound();
    if (item.allergensVerified) {
      const now = this.clock();
      await t.menu.revokeAllergenVerification(slug, now);
      await this.audit(restaurantId, actorUserId, "menu_item.allergens_unverified", "menu_item", slug, { allergens: item.allergens }, now);
    }
    const after = await t.menu.findAnyBySlug(slug);
    if (!after) throw notFound();
    return toAdminItem(after);
  }

  // ------------------------------------------------------------------ opening hours
  async getHours(restaurantId: RestaurantId) {
    const t = await this.ctx(restaurantId);
    const hours = await t.hours.get();
    return { timezone: t.restaurant.timezone, configured: hours !== null, hours: hours ? toAdminHours(hours) : null };
  }

  async replaceHours(restaurantId: RestaurantId, actorUserId: string, input: HoursInput) {
    const t = await this.ctx(restaurantId);
    const normalized = normalizeHours(input);
    const now = this.clock();
    await t.hours.replace(normalized, now);
    await this.audit(restaurantId, actorUserId, "hours.updated", "opening_hours", undefined, {
      openDays: normalized.weekly.filter((d) => d.periods.length > 0).map((d) => d.day), exceptions: normalized.exceptions.length,
    }, now);
    return { timezone: t.restaurant.timezone, configured: true, hours: toAdminHours({ ...normalized, updatedAt: now }) };
  }
}
