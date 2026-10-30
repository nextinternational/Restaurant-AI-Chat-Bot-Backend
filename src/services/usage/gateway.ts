import type { RestaurantId } from "../../domain/ids.js";
import type { Restaurant } from "../../domain/schemas.js";
import type { Repositories } from "../../repositories/index.js";
import type { UsageRepository } from "../../repositories/usageRepository.js";

/** Everything the usage-report API may touch for ONE tenant. Read-only. */
export interface UsageTenantContext {
  restaurant: Pick<Restaurant, "restaurantId" | "monthlyAiBudgetMicros">;
  usage: Pick<UsageRepository, "totals" | "byModel" | "topConversations">;
}

export interface UsageGateway {
  tenantContext(restaurantId: RestaurantId): Promise<UsageTenantContext | null>;
}

export function createUsageGateway(repos: Repositories): UsageGateway {
  return {
    async tenantContext(restaurantId) {
      const restaurant = await repos.getRestaurant(restaurantId);
      if (!restaurant) return null;
      return { restaurant, usage: repos.forTenant(restaurant).usage };
    },
  };
}
