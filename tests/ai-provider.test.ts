import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { OpenAiProvider } from "../src/ai/openaiProvider.js";
import { REPLY_SCHEMA } from "../src/ai/prompt.js";
import { TOOL_SPECS } from "../src/ai/tools.js";
import { estimateCostMicros } from "../src/ai/provider.js";

type Schema = { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };

describe("strict-mode JSON schemas", () => {
  const all: [string, Schema][] = [...TOOL_SPECS.map((t) => [t.name, t.parameters as Schema] as [string, Schema]), ["reply", REPLY_SCHEMA as unknown as Schema]];
  it.each(all)("%s: every property required, no extras, and no way to name a restaurant", (_name, schema) => {
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties ?? {}).sort());
    expect(JSON.stringify(schema).toLowerCase()).not.toContain("restaurant");
  });
  it("tool names are unique", () => {
    expect(new Set(TOOL_SPECS.map((t) => t.name)).size).toBe(TOOL_SPECS.length);
  });
});

describe("OpenAiProvider mapping", () => {
  it("sends strict tools + json_schema output and maps tool calls and usage back", async () => {
    let params: Record<string, unknown> = {};
    const client = {
      chat: {
        completions: {
          create: async (p: Record<string, unknown>) => {
            params = p;
            return {
              choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_location", arguments: "{}" } }] } }],
              usage: { prompt_tokens: 11, completion_tokens: 3 },
            };
          },
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiProvider("key", "some-model", 1000, client);
    const turn = await provider.complete({
      messages: [
        { role: "system", content: "s" }, { role: "user", content: "u" },
        { role: "assistant", content: null, toolCalls: [{ id: "c0", name: "get_location", arguments: "{}" }] },
        { role: "tool", toolCallId: "c0", content: "{}" },
      ],
      tools: TOOL_SPECS,
      responseSchema: REPLY_SCHEMA as unknown as Record<string, unknown>,
    });
    expect(turn).toEqual({ content: null, toolCalls: [{ id: "c1", name: "get_location", arguments: "{}" }], usage: { inputTokens: 11, outputTokens: 3 } });
    expect(params.model).toBe("some-model");
    expect(params.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true } });
    const tools = params.tools as { function: { strict: boolean } }[];
    expect(tools).toHaveLength(TOOL_SPECS.length);
    expect(tools.every((t) => t.function.strict)).toBe(true);
    const msgs = params.messages as { role: string; tool_calls?: unknown; tool_call_id?: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2]!.tool_calls).toBeDefined();
    expect(msgs[3]!.tool_call_id).toBe("c0");
  });

  it("estimates cost in integer micro-USD, rounding up", () => {
    expect(estimateCostMicros({ inputTokens: 1000, outputTokens: 500 }, { inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000 })).toBe(450);
    expect(estimateCostMicros({ inputTokens: 1, outputTokens: 0 }, { inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000 })).toBe(1);
  });
});
