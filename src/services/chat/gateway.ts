import type { RestaurantId } from "../../domain/ids.js";
import type { Restaurant } from "../../domain/schemas.js";
import type { ConversationRepository } from "../../repositories/conversationRepository.js";
import type { HoursRepository } from "../../repositories/hoursRepository.js";
import type { KnowledgeRepository } from "../../repositories/knowledgeRepository.js";
import type { MenuRepository } from "../../repositories/menuRepository.js";
import type { Repositories } from "../../repositories/index.js";
import type { ResolvedTenant } from "../../repositories/tenantResolver.js";
import type { UsageRepository } from "../../repositories/usageRepository.js";

export type ChatRestaurant = Pick<
  Restaurant,
  "restaurantId" | "name" | "timezone" | "currency" | "defaultLocale" | "monthlyAiBudgetMicros" | "location"
>;

/** Everything the chat feature may touch for ONE tenant. Built only from a server-resolved restaurantId. */
export interface ChatTenantContext {
  restaurant: ChatRestaurant;
  menu: Pick<MenuRepository, "findByName" | "list">;
  hours: Pick<HoursRepository, "get">;
  /** Published FAQs and policies only: the repository has no customer-facing read for drafts. */
  knowledge: Pick<KnowledgeRepository, "listPublishedFaqs" | "getPublishedPolicy">;
  conversations: Pick<
    ConversationRepository,
    "start" | "findBySessionToken" | "appendMessage" | "recentMessages" | "setSummary" | "close"
  >;
  usage: Pick<UsageRepository, "record" | "totals">;
}

export interface ChatGateway {
  resolveWidgetKey(publicKey: unknown): Promise<ResolvedTenant | null>;
  tenantContext(restaurantId: RestaurantId): Promise<ChatTenantContext | null>;
}

export function createChatGateway(repos: Repositories): ChatGateway {
  return {
    resolveWidgetKey: (key) => repos.tenantResolver.resolveWidgetKey(key),
    async tenantContext(restaurantId) {
      const restaurant = await repos.getRestaurant(restaurantId);
      if (!restaurant || restaurant.status !== "active") return null;
      const t = repos.forTenant(restaurant);
      return {
        restaurant,
        menu: t.menu,
        hours: t.hours,
        knowledge: t.knowledge,
        conversations: t.conversations,
        usage: t.usage,
      };
    },
  };
}
