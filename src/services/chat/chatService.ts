import { z } from "zod";
import type { Logger } from "pino";
import { AppError } from "../../errors.js";
import type { RestaurantId } from "../../domain/ids.js";
import { asksForPhoneNumber, cleanCustomerText, dietaryTermsIn, mentionsAllergy, mentionsPolicyTopic, sensitiveIngredientsIn, ungroundedAmounts, wantsHuman } from "../../ai/guards.js";
import { runTurn } from "../../ai/orchestrator.js";
import { buildSummary } from "../../domain/conversationSummary.js";
import type { ContactReason } from "../../ai/prompt.js";
import { estimateCostMicros, type ModelProvider } from "../../ai/provider.js";
import type { ResolvedTenant } from "../../repositories/tenantResolver.js";
import { contactMessage, dialable } from "./contact.js";
import type { ChatGateway, ChatTenantContext } from "./gateway.js";
import type { TurnFacts } from "../../ai/tools.js";

export const MAX_CUSTOMER_MESSAGE_CHARS = 1000;
/** How many messages older than the verbatim history window are read when the summary is rebuilt. */
const SUMMARY_LOOKBACK = 40;

export interface ChatConfig {
  maxMessagesPerConversation: number;
  defaultMonthlyBudgetMicros: number;
  price: { inputMicrosPerMtok: number; outputMicrosPerMtok: number };
  timeoutMs: number;
  maxToolIterations: number;
  historyLimit: number;
  /** A session idle for longer than this is refused (the customer simply starts a new chat). 0 disables the check. */
  sessionIdleMs?: number;
}

export interface ChatReply {
  /** `contact`: the assistant could not or must not answer, so the customer is given the restaurant's phone number. */
  type: "answer" | "contact";
  message: string;
  reason?: ContactReason;
  /** Present on `contact` replies when the restaurant has a dialable phone number; lets the widget render a call link. */
  contactPhone?: string;
}

const messageBody = z.object({ message: z.string().min(1).max(MAX_CUSTOMER_MESSAGE_CHARS * 2) });

export function originAllowed(allowed: readonly string[], origin: string | undefined): boolean {
  if (!origin || origin === "null") return false;
  try {
    return allowed.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export class ChatService {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly provider: ModelProvider,
    private readonly config: ChatConfig,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** For CORS: resolves the key only. The caller checks the origin. */
  resolveKey(widgetKey: unknown): Promise<ResolvedTenant | null> {
    return this.gateway.resolveWidgetKey(widgetKey);
  }

  /** Widget key -> tenant, then the exact-origin allow-list. One error for unknown key, another for wrong origin. */
  private async authorize(widgetKey: unknown, origin: string | undefined): Promise<{ resolved: ResolvedTenant; tenant: ChatTenantContext }> {
    const resolved = await this.gateway.resolveWidgetKey(widgetKey);
    if (!resolved) throw new AppError(404, "not_found", "Resource not found");
    if (!originAllowed(resolved.allowedOrigins, origin)) throw new AppError(403, "origin_not_allowed", "This site is not allowed to use this chat");
    const tenant = await this.gateway.tenantContext(resolved.restaurantId);
    if (!tenant) throw new AppError(404, "not_found", "Resource not found");
    return { resolved, tenant };
  }

  async startSession(widgetKey: unknown, origin: string | undefined): Promise<{ sessionToken: string; restaurantName: string }> {
    const { resolved, tenant } = await this.authorize(widgetKey, origin);
    const { sessionToken } = await tenant.conversations.start(resolved.widgetKeyId, this.clock());
    return { sessionToken, restaurantName: tenant.restaurant.name };
  }

  async sendMessage(widgetKey: unknown, origin: string | undefined, sessionToken: unknown, body: unknown): Promise<ChatReply> {
    const parsed = messageBody.safeParse(body ?? {});
    const text = parsed.success ? cleanCustomerText(parsed.data.message) : "";
    if (text.length < 1 || text.length > MAX_CUSTOMER_MESSAGE_CHARS) {
      throw new AppError(400, "bad_message", `Message must be 1-${MAX_CUSTOMER_MESSAGE_CHARS} characters`);
    }

    const { tenant } = await this.authorize(widgetKey, origin);
    // The lookup is tenant-scoped: a token minted for another restaurant simply does not exist here.
    const convo = await tenant.conversations.findBySessionToken(sessionToken);
    if (!convo) throw new AppError(401, "invalid_session", "Session not found or expired; start a new chat");
    const idleMs = this.config.sessionIdleMs ?? 0;
    if (idleMs > 0 && this.clock().getTime() - convo.lastActivityAt.getTime() > idleMs) {
      throw new AppError(401, "invalid_session", "Session not found or expired; start a new chat");
    }
    if (convo.status === "closed") throw new AppError(409, "conversation_closed", "This conversation is closed; start a new chat");
    if (convo.messageCount >= this.config.maxMessagesPerConversation) {
      throw new AppError(429, "conversation_limit", "This conversation reached its length limit; start a new chat");
    }

    const now = this.clock();
    await tenant.conversations.appendMessage(convo._id, { role: "user", content: text }, now);

    if (wantsHuman(text)) return this.contact(tenant, convo._id, "customer_request", text);
    if (asksForPhoneNumber(text)) return this.contact(tenant, convo._id, "phone_request", text);

    if (await this.overBudget(tenant, now)) {
      this.logger.warn({ restaurantId: tenant.restaurant.restaurantId }, "monthly AI budget exhausted; giving the contact number");
      return this.contact(tenant, convo._id, "other", text);
    }

    const recent = await tenant.conversations.recentMessages(convo._id, this.config.historyLimit);
    const history = recent.flatMap((m) => (m.role === "tool" ? [] : [{ role: m.role, content: m.content }]));
    const turn = await runTurn({
      provider: this.provider,
      tenant,
      history,
      ...(convo.summary ? { summary: convo.summary } : {}),
      now,
      logger: this.logger,
      maxIterations: this.config.maxToolIterations,
      timeoutMs: this.config.timeoutMs,
    });

    // Tokens were spent even if the answer is discarded below, so usage is always recorded.
    if (turn.usage.inputTokens + turn.usage.outputTokens > 0) {
      await tenant.usage.record({
        conversationId: convo._id,
        model: this.provider.model,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        estimatedCostMicros: estimateCostMicros(turn.usage, this.config.price),
      }, this.clock());
    }
    if (turn.providerFailed) throw new AppError(503, "ai_unavailable", "The assistant is temporarily unavailable; please try again");

    const override = this.safetyOverride(text, turn.decision, turn.facts);
    if (override) return this.contact(tenant, convo._id, override, text);
    if (turn.decision.type === "contact") return this.contact(tenant, convo._id, turn.decision.reason, text);

    await tenant.conversations.appendMessage(convo._id, { role: "assistant", content: turn.decision.message }, this.clock());
    await this.refreshSummary(tenant, convo._id);
    return { type: "answer", message: turn.decision.message };
  }

  /**
   * The guards. They run on code-owned facts (what the tools actually returned), so a persuasive
   * customer or a confused model cannot talk the system into stating an unverified price or allergen.
   */
  private safetyOverride(
    customerText: string,
    decision: { type: "answer"; message: string } | { type: "contact"; reason: ContactReason },
    facts: TurnFacts,
  ): ContactReason | null {
    // Any unverified or unknown allergen lookup ends with the contact number, whatever the model then says.
    if (facts.allergenLookups.some((l) => !l.found || !l.verified)) return "allergen_unverified";
    if (decision.type === "contact") return null;
    // Allergy talk is only answerable from verified data fetched in this very turn.
    if (mentionsAllergy(customerText) && facts.allergenLookups.length === 0) return "allergen_unverified";
    if (ungroundedAmounts(decision.message, facts.allowedAmountsCents).length > 0) return "unverified_information";
    // Halal, vegan, kosher and similar labels: only a label a menu tool returned this turn may be repeated, and a
    // customer asking about one gets an answer only after a dish was actually found.
    if (dietaryTermsIn(customerText).length > 0 && !facts.menuLookups.some((l) => l.found) && !facts.knowledgeLookups.some((l) => l.found)) return "unverified_information";
    if (dietaryTermsIn(decision.message).some((tag) => !facts.dietaryTagsSeen.has(tag))) return "unverified_information";
    // Pork, alcohol, gelatin: there is no label for them, so the answer may only name what the tool text itself says.
    if (sensitiveIngredientsIn(`${customerText} ${decision.message}`).some((w) => !facts.toolText.includes(w))) return "unverified_information";
    // Policy talk (cancellation, refunds, children, pets, payment, ...) is only answerable from published content found this turn.
    if (mentionsPolicyTopic(customerText) && !facts.knowledgeLookups.some((l) => l.found)) return "unverified_information";
    return null;
  }

  /**
   * Replies with the restaurant's phone number in fixed wording. The conversation stays active: the customer can
   * keep asking questions the assistant can answer. Nothing is sent to staff; there is no queue to monitor.
   */
  private async contact(tenant: ChatTenantContext, conversationId: Parameters<ChatTenantContext["conversations"]["appendMessage"]>[0], reason: ContactReason, customerText: string): Promise<ChatReply> {
    const phone = tenant.restaurant.location?.phone;
    const message = contactMessage(reason, phone, customerText);
    await tenant.conversations.appendMessage(conversationId, { role: "assistant", content: message }, this.clock());
    await this.refreshSummary(tenant, conversationId);
    const tel = dialable(phone);
    return { type: "contact", message, reason, ...(tel ? { contactPhone: tel } : {}) };
  }

  /**
   * Keeps the digest of what the customer asked BEFORE the verbatim window current. Best effort: a failure here
   * must never cost the customer their answer, the next turn simply retries.
   */
  private async refreshSummary(tenant: ChatTenantContext, conversationId: Parameters<ChatTenantContext["conversations"]["appendMessage"]>[0]): Promise<void> {
    try {
      const keep = this.config.historyLimit;
      const window = await tenant.conversations.recentMessages(conversationId, keep + SUMMARY_LOOKBACK);
      if (window.length <= keep) return;
      const summary = buildSummary(window, keep);
      if (summary) await tenant.conversations.setSummary(conversationId, summary);
    } catch (err) {
      this.logger.warn({ err }, "could not refresh the conversation summary");
    }
  }

  private async overBudget(tenant: ChatTenantContext, now: Date): Promise<boolean> {
    const budget = tenant.restaurant.monthlyAiBudgetMicros > 0 ? tenant.restaurant.monthlyAiBudgetMicros : this.config.defaultMonthlyBudgetMicros;
    if (budget <= 0) return false;
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const totals = await tenant.usage.totals(from, to);
    return totals.estimatedCostMicros >= budget;
  }
}

export type { RestaurantId };
