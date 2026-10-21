import { AppError } from "../errors.js";
import type { RestaurantId } from "../domain/ids.js";
import { normalizeOrigin } from "../domain/slug.js";
import type { AccountStore, RestaurantPatch, WidgetKeyView } from "../repositories/accountStore.js";

const MAX_ACTIVE_WIDGET_KEYS = 10;

/**
 * Operations a restaurant's own staff perform on their tenant. Callers must already have passed
 * `requireTenant(permission)`: the restaurantId here is the server-verified one, never client input.
 */
export class TenantAdminService {
  constructor(
    private readonly store: AccountStore,
    private readonly opts: { allowInsecureLocalhostOrigins: boolean },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getRestaurant(restaurantId: RestaurantId) {
    const restaurant = await this.store.getRestaurant(restaurantId);
    if (!restaurant) throw new AppError(404, "not_found", "Resource not found");
    return restaurant;
  }

  async updateRestaurant(restaurantId: RestaurantId, actorUserId: string, patch: RestaurantPatch) {
    const now = this.clock();
    const updated = await this.store.updateRestaurant(restaurantId, patch, now);
    if (!updated) throw new AppError(404, "not_found", "Resource not found");
    await this.store.recordAudit(
      restaurantId,
      { actorUserId, action: "restaurant.updated", resourceType: "restaurant", resourceId: restaurantId, metadata: { fields: Object.keys(patch) } },
      now,
    );
    return updated;
  }

  listTeam(restaurantId: RestaurantId) {
    return this.store.listTeam(restaurantId);
  }

  async getSubscription(restaurantId: RestaurantId) {
    const result = await this.store.getSubscription(restaurantId);
    if (!result) throw new AppError(404, "not_found", "Resource not found");
    return result;
  }

  listAudit(restaurantId: RestaurantId, limit: number, before?: Date) {
    return this.store.listAudit(restaurantId, { limit, ...(before ? { before } : {}) });
  }

  listWidgetKeys(restaurantId: RestaurantId) {
    return this.store.listWidgetKeys(restaurantId);
  }

  async createWidgetKey(restaurantId: RestaurantId, actorUserId: string, input: { allowedOrigins: string[]; label?: string }): Promise<WidgetKeyView> {
    const origins = new Set<string>();
    for (const raw of input.allowedOrigins) {
      const origin = normalizeOrigin(raw, this.opts.allowInsecureLocalhostOrigins);
      if (!origin) {
        throw new AppError(400, "invalid_origin", "Each origin must be a bare https origin such as https://example.com (no path, query or wildcard)");
      }
      origins.add(origin);
    }
    const existing = await this.store.listWidgetKeys(restaurantId);
    if (existing.filter((k) => k.status === "active").length >= MAX_ACTIVE_WIDGET_KEYS) {
      throw new AppError(409, "widget_key_limit", "Too many active widget keys; revoke one first");
    }
    const now = this.clock();
    const key = await this.store.createWidgetKey(
      restaurantId,
      { allowedOrigins: [...origins], ...(input.label !== undefined ? { label: input.label } : {}) },
      now,
    );
    await this.store.recordAudit(
      restaurantId,
      { actorUserId, action: "widget_key.created", resourceType: "widget_key", resourceId: key.keyId, metadata: { origins: key.allowedOrigins } },
      now,
    );
    return key;
  }

  async revokeWidgetKey(restaurantId: RestaurantId, actorUserId: string, keyId: string): Promise<void> {
    const now = this.clock();
    const revoked = await this.store.revokeWidgetKey(restaurantId, keyId, now);
    if (!revoked) throw new AppError(404, "not_found", "Resource not found");
    await this.store.recordAudit(
      restaurantId,
      { actorUserId, action: "widget_key.revoked", resourceType: "widget_key", resourceId: keyId },
      now,
    );
  }
}
