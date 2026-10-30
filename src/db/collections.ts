import type { Collection, Db } from "mongodb";
import type {
  ApiKey, AuditLog, Conversation, Faq, Membership, MenuItem, Message, OpeningHours, Plan, Policy, Restaurant, Subscription, UsageLog, User, UserSession, WidgetKey,
} from "../domain/schemas.js";

export const COLLECTIONS = {
  restaurants: "restaurants",
  widgetKeys: "widgetKeys",
  menuItems: "menuItems",
  openingHours: "openingHours",
  faqs: "faqs",
  policies: "policies",
  conversations: "conversations",
  messages: "messages",
  usageLogs: "usageLogs",
  users: "users",
  memberships: "memberships",
  sessions: "sessions",
  plans: "plans",
  subscriptions: "subscriptions",
  apiKeys: "apiKeys",
  auditLogs: "auditLogs",
  migrations: "_migrations",
} as const;

export interface Collections {
  restaurants: Collection<Restaurant>;
  widgetKeys: Collection<WidgetKey>;
  menuItems: Collection<MenuItem>;
  openingHours: Collection<OpeningHours>;
  faqs: Collection<Faq>;
  policies: Collection<Policy>;
  conversations: Collection<Conversation>;
  messages: Collection<Message>;
  usageLogs: Collection<UsageLog>;
  users: Collection<User>;
  memberships: Collection<Membership>;
  sessions: Collection<UserSession>;
  plans: Collection<Plan>;
  subscriptions: Collection<Subscription>;
  apiKeys: Collection<ApiKey>;
  auditLogs: Collection<AuditLog>;
}

/**
 * The single place in the code base allowed to call `db.collection()`
 * (ESLint enforces this everywhere outside src/db).
 */
export function getCollections(db: Db): Collections {
  return {
    restaurants: db.collection<Restaurant>(COLLECTIONS.restaurants),
    widgetKeys: db.collection<WidgetKey>(COLLECTIONS.widgetKeys),
    menuItems: db.collection<MenuItem>(COLLECTIONS.menuItems),
    openingHours: db.collection<OpeningHours>(COLLECTIONS.openingHours),
    faqs: db.collection<Faq>(COLLECTIONS.faqs),
    policies: db.collection<Policy>(COLLECTIONS.policies),
    conversations: db.collection<Conversation>(COLLECTIONS.conversations),
    messages: db.collection<Message>(COLLECTIONS.messages),
    usageLogs: db.collection<UsageLog>(COLLECTIONS.usageLogs),
    users: db.collection<User>(COLLECTIONS.users),
    memberships: db.collection<Membership>(COLLECTIONS.memberships),
    sessions: db.collection<UserSession>(COLLECTIONS.sessions),
    plans: db.collection<Plan>(COLLECTIONS.plans),
    subscriptions: db.collection<Subscription>(COLLECTIONS.subscriptions),
    apiKeys: db.collection<ApiKey>(COLLECTIONS.apiKeys),
    auditLogs: db.collection<AuditLog>(COLLECTIONS.auditLogs),
  };
}
