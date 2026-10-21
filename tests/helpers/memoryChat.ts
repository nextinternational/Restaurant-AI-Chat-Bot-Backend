import { ObjectId, type WithId } from "mongodb";
import { parseRestaurantId, type RestaurantId } from "../../src/domain/ids.js";
import type { Conversation, Faq, MenuItem, Message, OpeningHours, Policy, Restaurant, UsageLog } from "../../src/domain/schemas.js";
import { generateSessionToken, generateWidgetKey, hashToken } from "../../src/security/tokens.js";
import { normalizeName } from "../../src/repositories/normalize.js";
import type { ChatGateway, ChatTenantContext } from "../../src/services/chat/gateway.js";
import type { ModelProvider, ModelRequest, ModelTurn, ToolCall } from "../../src/ai/provider.js";

export const NOW = new Date("2026-10-10T15:00:00Z"); // Saturday 11:00 in America/Antigua

export function menuItem(p: Partial<MenuItem> & Pick<MenuItem, "slug" | "name" | "priceCents">, restaurantId: RestaurantId): MenuItem {
  return {
    restaurantId, nameNormalized: normalizeName(p.name), category: "Mains", currency: "USD", status: "active", available: true,
    dietaryTags: [], allergens: [], allergensVerified: false, createdAt: NOW, updatedAt: NOW, ...p,
  };
}

export interface TenantSeed {
  restaurantId: string;
  name: string;
  origin: string;
  items: (Partial<MenuItem> & Pick<MenuItem, "slug" | "name" | "priceCents">)[];
  hours?: Pick<OpeningHours, "weekly" | "exceptions">;
  /** Knowledge base content; `status` defaults to "published" so a seed reads as live content. */
  faqs?: (Partial<Faq> & Pick<Faq, "slug" | "question" | "answer">)[];
  policies?: (Partial<Policy> & Pick<Policy, "kind" | "body">)[];
  location?: Restaurant["location"];
  monthlyAiBudgetMicros?: number;
}

/** Per-tenant stores: a context built for tenant A physically cannot see tenant B's arrays. */
class TenantStore {
  conversations: WithId<Conversation>[] = [];
  messages: Message[] = [];
  usage: UsageLog[] = [];
  constructor(
    readonly restaurant: Restaurant, readonly items: MenuItem[], readonly hours: OpeningHours | null,
    readonly faqs: Faq[] = [], readonly policies: Policy[] = [],
  ) {}
}

export class MemoryChatGateway implements ChatGateway {
  stores = new Map<string, TenantStore>();
  keys = new Map<string, { restaurantId: RestaurantId; widgetKeyId: string; allowedOrigins: string[] }>();
  /** Every tenant the chat code asked for: proves which tenants a request could reach. */
  contextRequests: string[] = [];

  addTenant(seed: TenantSeed): string {
    const restaurantId = parseRestaurantId(seed.restaurantId);
    const restaurant: Restaurant = {
      restaurantId, slug: seed.name.toLowerCase().replace(/\W+/g, "-"), name: seed.name, status: "active", timezone: "America/Antigua",
      currency: "USD", defaultLocale: "en", retention: {}, monthlyAiBudgetMicros: seed.monthlyAiBudgetMicros ?? 0,
      ...(seed.location ? { location: seed.location } : {}),
      createdAt: NOW, updatedAt: NOW,
    };
    const hours = seed.hours ? { ...seed.hours, restaurantId, updatedAt: NOW } : null;
    const faqs: Faq[] = (seed.faqs ?? []).map((f) => ({
      restaurantId, category: undefined, keywords: [], status: "published" as const, publishedAt: NOW, createdAt: NOW, updatedAt: NOW, ...f,
    })).map(({ category, ...f }) => (category === undefined ? f : { ...f, category }));
    const policies: Policy[] = (seed.policies ?? []).map((p) => ({
      restaurantId, title: p.kind, status: "published" as const, publishedAt: NOW, createdAt: NOW, updatedAt: NOW, ...p,
    }));
    this.stores.set(restaurantId, new TenantStore(restaurant, seed.items.map((i) => menuItem(i, restaurantId)), hours, faqs, policies));
    const publicKey = generateWidgetKey();
    this.keys.set(publicKey, { restaurantId, widgetKeyId: new ObjectId().toHexString(), allowedOrigins: [seed.origin] });
    return publicKey;
  }

  async resolveWidgetKey(key: unknown) {
    return typeof key === "string" ? (this.keys.get(key) ?? null) : null;
  }

  async tenantContext(restaurantId: RestaurantId): Promise<ChatTenantContext | null> {
    this.contextRequests.push(restaurantId);
    const s = this.stores.get(restaurantId);
    if (!s) return null;
    const rid = s.restaurant.restaurantId;
    return {
      restaurant: s.restaurant,
      menu: {
        findByName: async (name) => s.items.filter((i) => i.status === "active" && i.nameNormalized === normalizeName(name)).slice(0, 5),
        list: async (o = {}) => s.items.filter((i) => i.status === "active" && (!o.category || i.category === o.category)).slice(0, o.limit ?? 50),
      },
      hours: { get: async () => s.hours },
      knowledge: {
        // Same contract as the repository: ONLY published content is ever returned to the assistant.
        listPublishedFaqs: async () => s.faqs.filter((f) => f.status === "published"),
        getPublishedPolicy: async (kind) => s.policies.find((p) => p.kind === kind && p.status === "published") ?? null,
      },
      usage: {
        record: async (e, now = NOW) => { s.usage.push({ ...e, restaurantId: rid, createdAt: now, expiresAt: now }); },
        totals: async (from, to) => {
          const rows = s.usage.filter((u) => u.createdAt >= from && u.createdAt < to);
          return {
            requests: rows.length, inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
            outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0), estimatedCostMicros: rows.reduce((a, r) => a + r.estimatedCostMicros, 0),
          };
        },
      },
      conversations: {
        start: async (widgetKeyId, now = NOW) => {
          const sessionToken = generateSessionToken();
          const _id = new ObjectId();
          s.conversations.push({
            _id, restaurantId: rid, sessionTokenHash: hashToken(sessionToken), ...(widgetKeyId ? { widgetKeyId } : {}),
            status: "active", messageCount: 0, createdAt: now, lastActivityAt: now, expiresAt: now,
          });
          return { conversationId: _id, sessionToken };
        },
        findBySessionToken: async (token) =>
          typeof token === "string" ? (s.conversations.find((c) => c.sessionTokenHash === hashToken(token)) ?? null) : null,
        appendMessage: async (conversationId, msg, now = NOW) => {
          const c = s.conversations.find((x) => x._id.equals(conversationId));
          if (!c) throw new Error("conversation not in this tenant");
          s.messages.push({ restaurantId: rid, conversationId, role: msg.role, content: msg.content, createdAt: now, expiresAt: now });
          c.messageCount += 1;
          c.lastActivityAt = now;
        },
        recentMessages: async (conversationId, limit = 10) => s.messages.filter((m) => m.conversationId.equals(conversationId)).slice(-limit),
        setSummary: async (conversationId, summary) => {
          const c = s.conversations.find((x) => x._id.equals(conversationId));
          if (c) c.summary = summary;
        },
        close: async (conversationId) => {
          const c = s.conversations.find((x) => x._id.equals(conversationId));
          if (!c || c.status === "closed") return false;
          c.status = "closed";
          return true;
        },
      },
    };
  }
}

// ------------------------------------------------------------------ scripted model
export const toolCall = (name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const usage = { inputTokens: 100, outputTokens: 20 };
export const callTools = (...calls: ToolCall[]): ModelTurn => ({ content: null, toolCalls: calls, usage });
export const finalAnswer = (message: string): ModelTurn => ({ content: JSON.stringify({ type: "answer", message, reason: null }), toolCalls: [], usage });
export const finalContact = (reason: string): ModelTurn => ({ content: JSON.stringify({ type: "contact", message: "x", reason }), toolCalls: [], usage });
export const finalRaw = (content: string): ModelTurn => ({ content, toolCalls: [], usage });

export class ScriptedModel implements ModelProvider {
  readonly model = "fake-model";
  calls: ModelRequest[] = [];
  constructor(private readonly script: (callIndex: number, req: ModelRequest) => ModelTurn | Promise<ModelTurn>) {}
  async complete(req: ModelRequest): Promise<ModelTurn> {
    this.calls.push({ ...req, messages: [...req.messages] });
    return this.script(this.calls.length - 1, req);
  }
}
