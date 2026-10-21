import { z } from "zod";
import type { Logger } from "pino";
import type { ChatTenantContext } from "../services/chat/gateway.js";
import { buildSystemPrompt, MODEL_CONTACT_REASONS, REPLY_SCHEMA, type ContactReason } from "./prompt.js";
import type { ModelMessage, ModelProvider, ModelUsage } from "./provider.js";
import { executeTool, newTurnFacts, TOOL_SPECS, type TurnFacts } from "./tools.js";

const replySchema = z.object({
  type: z.enum(["answer", "contact"]),
  message: z.string().trim().min(1).max(1500),
  reason: z.enum(MODEL_CONTACT_REASONS).nullable(),
});

export type Decision =
  | { type: "answer"; message: string }
  | { type: "contact"; reason: ContactReason };

export interface TurnResult {
  decision: Decision;
  usage: ModelUsage;
  facts: TurnFacts;
  /** True when the provider threw (timeout, outage, quota). The caller decides what the customer sees. */
  providerFailed: boolean;
}

export interface TurnInput {
  provider: ModelProvider;
  tenant: ChatTenantContext;
  history: { role: "user" | "assistant"; content: string }[];
  summary?: string;
  now: Date;
  logger: Logger;
  maxIterations: number;
  timeoutMs: number;
}

const MAX_TOOL_CALLS_PER_ROUND = 4;

/** Runs the tool-calling loop. It returns the model's proposal; it does NOT apply the safety guards. */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const facts = newTurnFacts();
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
  const messages: ModelMessage[] = [
    { role: "system", content: buildSystemPrompt(input.tenant.restaurant, input.now, input.summary) },
    ...input.history.map((m) => ({ role: m.role, content: m.content }) as ModelMessage),
  ];
  const signal = AbortSignal.timeout(input.timeoutMs);
  const uncertain: Decision = { type: "contact", reason: "model_uncertain" };

  try {
    for (let i = 0; i < input.maxIterations; i++) {
      const turn = await input.provider.complete({ messages, tools: TOOL_SPECS, responseSchema: REPLY_SCHEMA, signal });
      usage.inputTokens += turn.usage.inputTokens;
      usage.outputTokens += turn.usage.outputTokens;

      if (turn.toolCalls.length === 0) {
        let raw: unknown;
        try {
          raw = JSON.parse(turn.content ?? "");
        } catch {
          return { decision: uncertain, usage, facts, providerFailed: false };
        }
        const parsed = replySchema.safeParse(raw);
        if (!parsed.success) return { decision: uncertain, usage, facts, providerFailed: false };
        const r = parsed.data;
        return {
          decision: r.type === "answer" ? { type: "answer", message: r.message } : { type: "contact", reason: r.reason ?? "model_uncertain" },
          usage, facts, providerFailed: false,
        };
      }

      messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
      for (const call of turn.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)) {
        const output = await executeTool(call.name, call.arguments, { tenant: input.tenant, now: input.now, facts, logger: input.logger });
        messages.push({ role: "tool", toolCallId: call.id, content: output });
      }
      // Any tool call beyond the cap still needs a reply or the provider rejects the next request.
      for (const call of turn.toolCalls.slice(MAX_TOOL_CALLS_PER_ROUND)) {
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: "too_many_tool_calls" }) });
      }
    }
    return { decision: uncertain, usage, facts, providerFailed: false };
  } catch (err) {
    input.logger.error({ err }, "model provider failed");
    return { decision: uncertain, usage, facts, providerFailed: true };
  }
}
