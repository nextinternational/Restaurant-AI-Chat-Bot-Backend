import type { RestaurantId } from "../../domain/ids.js";
import type { Restaurant } from "../../domain/schemas.js";
import type { HoursRepository } from "../../repositories/hoursRepository.js";
import type { MenuRepository } from "../../repositories/menuRepository.js";
import type { Repositories } from "../../repositories/index.js";

/** Everything the catalog (menu + hours) management API may touch for ONE tenant. */
export interface CatalogTenantContext {
  restaurant: Pick<Restaurant, "restaurantId" | "currency" | "timezone">;
  menu: Pick<
    MenuRepository,
    "create" | "findAnyBySlug" | "findByName" | "listForAdmin" | "update" | "setStatus" | "setAllergens" | "revokeAllergenVerification"
  >;
  hours: Pick<HoursRepository, "get" | "replace">;
}

export interface CatalogGateway {
  tenantContext(restaurantId: RestaurantId): Promise<CatalogTenantContext | null>;
}

export function createCatalogGateway(repos: Repositories): CatalogGateway {
  return {
    async tenantContext(restaurantId) {
      const restaurant = await repos.getRestaurant(restaurantId);
      if (!restaurant || restaurant.status !== "active") return null;
      const t = repos.forTenant(restaurant);
      return { restaurant, menu: t.menu, hours: t.hours };
    },
  };
}
