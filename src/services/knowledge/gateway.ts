import type { RestaurantId } from "../../domain/ids.js";
import type { Restaurant } from "../../domain/schemas.js";
import type { Repositories } from "../../repositories/index.js";
import type { KnowledgeRepository } from "../../repositories/knowledgeRepository.js";

/** Everything the FAQ / policy management API may touch for ONE tenant. */
export interface KnowledgeTenantContext {
  restaurant: Pick<Restaurant, "restaurantId">;
  knowledge: Pick<
    KnowledgeRepository,
    | "createFaq" | "findAnyFaqBySlug" | "countLiveFaqs" | "listFaqsForAdmin" | "updateFaq" | "setFaqStatus"
    | "getAnyPolicy" | "listPolicies" | "savePolicy" | "setPolicyStatus"
  >;
}

export interface KnowledgeGateway {
  tenantContext(restaurantId: RestaurantId): Promise<KnowledgeTenantContext | null>;
}

export function createKnowledgeGateway(repos: Repositories): KnowledgeGateway {
  return {
    async tenantContext(restaurantId) {
      const restaurant = await repos.getRestaurant(restaurantId);
      if (!restaurant || restaurant.status !== "active") return null;
      return { restaurant, knowledge: repos.forTenant(restaurant).knowledge };
    },
  };
}
