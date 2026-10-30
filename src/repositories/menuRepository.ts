import type { Collections } from "../db/collections.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import type { RestaurantId } from "../domain/ids.js";
import { planMenuPatch, type MenuItemPatch } from "../domain/catalogRules.js";
import { menuItemSchema, type MenuItem } from "../domain/schemas.js";
import { AppError } from "../errors.js";
import { normalizeName } from "./normalize.js";

export type NewMenuItem = Omit<MenuItem, "restaurantId" | "nameNormalized" | "createdAt" | "updatedAt">;

export class MenuRepository {
  private readonly items: ScopedCollection<MenuItem>;
  constructor(cols: Collections, restaurantId: RestaurantId) {
    this.items = new ScopedCollection(cols.menuItems, restaurantId);
  }

  async create(input: NewMenuItem, now = new Date()): Promise<void> {
    const doc = menuItemSchema.parse({
      ...input,
      restaurantId: this.items.restaurantId,
      nameNormalized: normalizeName(input.name),
      createdAt: now,
      updatedAt: now,
    });
    const { restaurantId: _omit, ...rest } = doc;
    void _omit;
    try {
      await this.items.insertOne(rest);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError(409, "conflict", "Menu item slug already exists");
      throw err;
    }
  }

  findBySlug(slug: string): Promise<MenuItem | null> {
    return this.items.findOne({ slug: String(slug), status: "active" });
  }

  /** Exact match on the normalised name; ambiguity is the caller's problem (it should hand off, not guess). */
  async findByName(name: string): Promise<MenuItem[]> {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    return this.items.find({ nameNormalized: normalized, status: "active" }, { limit: 5 });
  }

  list(opts: { category?: string; limit?: number } = {}): Promise<MenuItem[]> {
    return this.items.find(
      { status: "active", ...(opts.category ? { category: String(opts.category) } : {}) },
      { limit: opts.limit ?? 50, sort: { category: 1, name: 1 } },
    );
  }

  /** Records a human verification of allergen data (who, and when) together with the verified list. */
  async setAllergens(slug: string, allergens: MenuItem["allergens"], verifiedBy: string, now = new Date()): Promise<boolean> {
    const res = await this.items.updateOne(
      { slug },
      { $set: { allergens, allergensVerified: true, allergensVerifiedAt: now, allergensVerifiedBy: verifiedBy, updatedAt: now } },
    );
    return res.matchedCount === 1;
  }

  async updatePrice(slug: string, priceCents: number, now = new Date()): Promise<boolean> {
    if (!Number.isInteger(priceCents) || priceCents < 0) throw new AppError(400, "bad_price", "priceCents must be a non-negative integer");
    const res = await this.items.updateOne({ slug }, { $set: { priceCents, updatedAt: now } });
    return res.matchedCount === 1;
  }

  // ------------------------------------------------------------------ management API (Step 7)
  /** Any status. Customer-facing reads must keep using `findBySlug` / `findByName` (active only). */
  findAnyBySlug(slug: string): Promise<MenuItem | null> {
    return this.items.findOne({ slug: String(slug) });
  }

  /** Staff listing, stable order by slug so `after` works as a cursor on the unique (restaurantId, slug) index. */
  listForAdmin(opts: { status: "active" | "archived" | "all"; category?: string; after?: string; limit: number }): Promise<MenuItem[]> {
    return this.items.find(
      {
        ...(opts.status === "all" ? {} : { status: opts.status }),
        ...(opts.category ? { category: String(opts.category) } : {}),
        ...(opts.after ? { slug: { $gt: String(opts.after) } } : {}),
      },
      { limit: opts.limit, sort: { slug: 1 } },
    );
  }

  /** Validated partial update. Returns the new document, `null` when the item does not exist, or `current` when nothing changed. */
  async update(slug: string, patch: MenuItemPatch, now = new Date()): Promise<{ item: MenuItem; changed: string[] } | null> {
    const current = await this.findAnyBySlug(slug);
    if (!current) return null;
    const plan = planMenuPatch(current, patch, now);
    if (plan.changed.length === 0) return { item: current, changed: [] };
    const res = await this.items.updateOne(
      { slug },
      { $set: plan.set, ...(plan.unset.length > 0 ? { $unset: Object.fromEntries(plan.unset.map((k) => [k, ""])) } : {}) },
    );
    return res.matchedCount === 1 ? { item: plan.next, changed: plan.changed } : null;
  }

  async setStatus(slug: string, status: MenuItem["status"], now = new Date()): Promise<boolean> {
    const res = await this.items.updateOne({ slug }, { $set: { status, updatedAt: now } });
    return res.matchedCount === 1;
  }

  /** Back to "not verified": the assistant stops stating allergens for this item and hands off instead. */
  async revokeAllergenVerification(slug: string, now = new Date()): Promise<boolean> {
    const res = await this.items.updateOne(
      { slug },
      { $set: { allergensVerified: false, updatedAt: now }, $unset: { allergensVerifiedAt: "", allergensVerifiedBy: "" } },
    );
    return res.matchedCount === 1;
  }
}
