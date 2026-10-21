import { describe, it, expect } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { buildSummary, MAX_SUMMARY_QUESTIONS } from "../src/domain/conversationSummary.js";
import { ChatService } from "../src/services/chat/chatService.js";
import { MemoryChatGateway, NOW, ScriptedModel, finalAnswer } from "./helpers/memoryChat.js";

const ORIGIN = "https://harbor.example";
const user = (content: string) => ({ role: "user" as const, content });
const bot = (content: string) => ({ role: "assistant" as const, content });

describe("buildSummary", () => {
  it("returns nothing while the whole conversation still fits in the verbatim window", () => {
    expect(buildSummary([user("hi"), bot("hello")], 10)).toBeUndefined();
  });

  it("digests only the customer's own older questions, never what the assistant said", () => {
    const msgs = [user("What time do you close?"), bot("We close at 10 PM, the salmon is $38."), user("Vegetarian?"), bot("Yes"), user("latest"), bot("ok")];
    const s = buildSummary(msgs, 2)!;
    expect(s).toContain("What time do you close?");
    expect(s).toContain("Vegetarian?");
    expect(s).not.toContain("latest");
    expect(s).not.toContain("$38");
  });

  it("is bounded: newest questions win, long lines are cut, whitespace is flattened", () => {
    const many = Array.from({ length: 30 }, (_, i) => user(`question ${i}`));
    const s = buildSummary([...many, user("x"), bot("y")], 2)!;
    expect(s.split("\n")).toHaveLength(MAX_SUMMARY_QUESTIONS);
    expect(s).toContain("question 29");
    expect(s).not.toContain("question 0\n");
    const long = buildSummary([user(`a\n\n${"b".repeat(500)}`), user("z"), bot("y")], 2)!;
    expect(long.length).toBeLessThan(200);
    expect(long).not.toMatch(/\n./);
  });
});

describe("rolling summary in the chat path", () => {
  const setup = () => {
    const gateway = new MemoryChatGateway();
    const key = gateway.addTenant({ restaurantId: "rest_001", name: "Harbor Grill", origin: ORIGIN, items: [{ slug: "salmon", name: "Grilled Salmon", priceCents: 3800 }] });
    const model = new ScriptedModel(() => finalAnswer("Sure."));
    const service = new ChatService(
      gateway, model,
      { maxMessagesPerConversation: 100, defaultMonthlyBudgetMicros: 0, price: { inputMicrosPerMtok: 0, outputMicrosPerMtok: 0 }, timeoutMs: 5000, maxToolIterations: 4, historyLimit: 4 },
      pino({ level: "silent" }), () => NOW,
    );
    const env = loadEnv({ NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000", CHAT_MESSAGES_PER_SESSION_MIN: "1000", CHAT_MESSAGES_PER_KEY_MIN: "1000" });
    return { app: createApp({ env, logger: pino({ level: "silent" }), readinessChecks: [], chat: { service } }), gateway, model, key };
  };

  it("keeps older questions available to the model once they fall out of the recent window, labelled as data", async () => {
    const c = setup();
    const { body } = await request(c.app).post(`/v1/chat/${c.key}/sessions`).set("Origin", ORIGIN).send({});
    const say = (m: string) => request(c.app).post(`/v1/chat/${c.key}/messages`).set("Origin", ORIGIN).set("Authorization", `Bearer ${body.sessionToken}`).send({ message: m });

    for (const m of ["What time do you close?", "Do you have vegetarian options?", "Is there parking?", "What about Saturday?"]) {
      expect((await say(m)).status).toBe(200);
    }

    const store = c.gateway.stores.get("rest_001")!;
    expect(store.conversations[0]!.summary).toContain("What time do you close?");

    const system = c.model.calls.at(-1)!.messages[0]!;
    expect(JSON.stringify(system)).toContain("What time do you close?");
    expect(JSON.stringify(system)).toContain("asked earlier in this conversation");
    // The first turns have no summary yet: it only appears once something left the window.
    expect(JSON.stringify(c.model.calls[0]!.messages[0])).not.toContain("asked earlier in this conversation");
  });
});
