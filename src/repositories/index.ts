import type { Db } from "mongodb";
import { getCollections, type Collections } from "../db/collections.js";
import type { RetentionDefaults } from "../db/retention.js";
import type { RestaurantId } from "../domain/ids.js";
import { restaurantSchema, type Restaurant } from "../domain/schemas.js";
import { ScopedCollection } from "../db/scopedCollection.js";
import { ConversationRepository } from "./conversationRepository.js";
import { HoursRepository } from "./hoursRepository.js";
import { KnowledgeRepository } from "./knowledgeRepository.js";
import { MenuRepository } from "./menuRepository.js";
import { TenantResolver } from "./tenantResolver.js";
import { MongoAccountStore, type AccountStore } from "./accountStore.js";
import { UsageRepository } from "./usageRepository.js";

export interface TenantRepositories {
  restaurantId: RestaurantId;
  menu: MenuRepository;
  hours: HoursRepository;
  knowledge: KnowledgeRepository;
  conversations: ConversationRepository;
  usage: UsageRepository;
}

export interface Repositories {
  cols: Collections;
  tenantResolver: TenantResolver;
  /** Users, sessions, memberships, onboarding, plans, audit and widget-key management (Step 4). */
  accounts: AccountStore;
  /** Everything a request handler needs, hard-bound to a single tenant. */
  forTenant(restaurant: Pick<Restaurant, "restaurantId" | "retention">): TenantRepositories;
  getRestaurant(restaurantId: RestaurantId): Promise<Restaurant | null>;
}

export function createRepositories(db: Db, retention: RetentionDefaults): Repositories {
  const cols = getCollections(db);
  return {
    cols,
    tenantResolver: new TenantResolver(cols),
    accounts: new MongoAccountStore(cols),
    forTenant(restaurant) {
      const id = restaurant.restaurantId;
      return {
        restaurantId: id,
        menu: new MenuRepository(cols, id),
        hours: new HoursRepository(cols, id),
        knowledge: new KnowledgeRepository(cols, id),
        conversations: new ConversationRepository(cols, id, retention, restaurant),
        usage: new UsageRepository(cols, id, retention, restaurant),
      };
    },
    async getRestaurant(restaurantId) {
      const doc = await new ScopedCollection(cols.restaurants, restaurantId).findOne({});
      return doc ? restaurantSchema.parse(doc) : null;
    },
  };
}
