import type { RestaurantId } from "../../src/domain/ids.js";
import { planMenuPatch } from "../../src/domain/catalogRules.js";
import type { MenuItem, OpeningHours } from "../../src/domain/schemas.js";
import { menuItemSchema, openingHoursSchema } from "../../src/domain/schemas.js";
import { AppError } from "../../src/errors.js";
import { normalizeName } from "../../src/repositories/normalize.js";
import type { CatalogGateway, CatalogTenantContext } from "../../src/services/catalog/gateway.js";

/**
 * Per-tenant in-memory stores with the same observable contract as MenuRepository / HoursRepository.
 * Patch logic is the SHARED `planMenuPatch`, so rules cannot drift between this double and production.
 */
class Tenant {
  items: MenuItem[] = [];
  hours: OpeningHours | null = null;
}

export class MemoryCatalogGateway implements CatalogGateway {
  tenants = new Map<string, Tenant>();
  currency = "XCD";

  async tenantContext(restaurantId: RestaurantId): Promise<CatalogTenantContext | null> {
    const t = this.tenants.get(restaurantId) ?? new Tenant();
    this.tenants.set(restaurantId, t);
    return {
      restaurant: { restaurantId, currency: this.currency, timezone: "America/Antigua" },
      menu: {
        create: async (input, now = new Date()) => {
          if (t.items.some((i) => i.slug === input.slug)) throw new AppError(409, "conflict", "Menu item slug already exists");
          t.items.push(menuItemSchema.parse({ ...input, restaurantId, nameNormalized: normalizeName(input.name), createdAt: now, updatedAt: now }));
        },
        findAnyBySlug: async (slug) => t.items.find((i) => i.slug === slug) ?? null,
        findByName: async (name) => t.items.filter((i) => i.status === "active" && i.nameNormalized === normalizeName(name)).slice(0, 5),
        listForAdmin: async (o) =>
          t.items
            .filter((i) => (o.status === "all" || i.status === o.status) && (!o.category || i.category === o.category) && (!o.after || i.slug > o.after))
            .sort((a, b) => a.slug.localeCompare(b.slug))
            .slice(0, o.limit),
        update: async (slug, patch, now = new Date()) => {
          const current = t.items.find((i) => i.slug === slug);
          if (!current) return null;
          const plan = planMenuPatch(current, patch, now);
          if (plan.changed.length > 0) t.items = t.items.map((i) => (i === current ? plan.next : i));
          return { item: plan.next, changed: plan.changed };
        },
        setStatus: async (slug, status, now = new Date()) => {
          const i = t.items.find((x) => x.slug === slug);
          if (!i) return false;
          Object.assign(i, { status, updatedAt: now });
          return true;
        },
        setAllergens: async (slug, allergens, verifiedBy, now = new Date()) => {
          const i = t.items.find((x) => x.slug === slug);
          if (!i) return false;
          Object.assign(i, { allergens, allergensVerified: true, allergensVerifiedAt: now, allergensVerifiedBy: verifiedBy, updatedAt: now });
          return true;
        },
        revokeAllergenVerification: async (slug, now = new Date()) => {
          const i = t.items.find((x) => x.slug === slug);
          if (!i) return false;
          i.allergensVerified = false;
          delete i.allergensVerifiedAt;
          delete i.allergensVerifiedBy;
          i.updatedAt = now;
          return true;
        },
      },
      hours: {
        get: async () => t.hours,
        replace: async (input, now = new Date()) => {
          t.hours = openingHoursSchema.parse({ ...input, restaurantId, updatedAt: now });
        },
      },
    };
  }
}
