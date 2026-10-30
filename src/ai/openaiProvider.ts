import OpenAI from "openai";
import type { ModelMessage, ModelProvider, ModelRequest, ModelTurn } from "./provider.js";

function toOpenAi(m: ModelMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
  }
}

export class OpenAiProvider implements ModelProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    timeoutMs: number,
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI({ apiKey, maxRetries: 1, timeout: timeoutMs });
  }

  async complete(req: ModelRequest): Promise<ModelTurn> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: req.messages.map(toOpenAi),
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
        })),
        response_format: { type: "json_schema", json_schema: { name: "chat_reply", strict: true, schema: req.responseSchema } },
        max_completion_tokens: 600,
      },
      req.signal ? { signal: req.signal } : undefined,
    );
    const choice = res.choices[0];
    const toolCalls = (choice?.message.tool_calls ?? []).flatMap((c) =>
      c.type === "function" ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
    );
    return {
      content: choice?.message.content ?? null,
      toolCalls,
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
    };
  }
}
