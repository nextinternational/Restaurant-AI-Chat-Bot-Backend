import { describe, expect, it } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { buildSystemPrompt } from "../src/ai/prompt.js";
import { TOOL_SPECS } from "../src/ai/tools.js";
import { POLICY_KINDS } from "../src/domain/schemas.js";
import { ChatService, type ChatConfig } from "../src/services/chat/chatService.js";
import { MemoryChatGateway, NOW, ScriptedModel, callTools, finalAnswer, toolCall } from "./helpers/memoryChat.js";

const logger = pino({ level: "silent" });
const ORIGIN_A = "https://harbor.example";
const ORIGIN_B = "https://olive.example";
const config: ChatConfig = {
  maxMessagesPerConversation: 100, defaultMonthlyBudgetMicros: 10_000_000, price: { inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000 },
  timeoutMs: 5000, maxToolIterations: 4, historyLimit: 10,
};

function setup(script: ConstructorParameters<typeof ScriptedModel>[0]) {
  const gateway = new MemoryChatGateway();
  const keyA = gateway.addTenant({
    restaurantId: "rest_001", name: "Harbor Grill", origin: ORIGIN_A,
    location: { address: "1 Beach Road, St John's", phone: "+1 268 555 0100" },
    items: [{ slug: "grilled-salmon", name: "Grilled Salmon", priceCents: 3800 }, { slug: "hot-dog", name: "Hot Dog", priceCents: 900 }],
    faqs: [
      { slug: "wifi", question: "Do you have free WiFi?", answer: "Yes, ask your server for the password.", keywords: ["internet"] },
      { slug: "cake", question: "Can I order a birthday cake?", answer: "Yes. Cakes cost $45 and need 48 hours notice.", keywords: ["celebration"] },
      { slug: "draft-only", question: "Do you host live music?", answer: "Every Friday night.", status: "draft" },
      { slug: "old", question: "Is there a happy hour?", answer: "Yes, 5 to 7 pm.", status: "archived" },
    ],
    policies: [
      { kind: "pets", title: "Pets policy", body: "Small dogs are welcome on the terrace only." },
      { kind: "corkage", title: "Corkage policy", body: "Corkage is $25 per bottle.", },
      { kind: "cancellation", title: "Cancellation policy", body: "Cancel up to 24 hours ahead for free.", status: "draft" },
    ],
  });
  const keyB = gateway.addTenant({
    restaurantId: "rest_002", name: "Olive Demo", origin: ORIGIN_B, items: [],
    faqs: [{ slug: "wifi", question: "Do you have free WiFi?", answer: "No WiFi, sorry. Enjoy the view." }],
    policies: [{ kind: "pets", title: "Pets policy", body: "No animals at all." }],
  });
  const model = new ScriptedModel(script);
  const service = new ChatService(gateway, model, config, logger, () => NOW);
  const env = loadEnv({
    NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000",
    CHAT_SESSIONS_PER_IP_HOUR: "1000", CHAT_SESSIONS_PER_KEY_HOUR: "1000", CHAT_MESSAGES_PER_SESSION_MIN: "1000", CHAT_MESSAGES_PER_KEY_MIN: "1000",
  });
  const app = createApp({ env, logger, readinessChecks: [], chat: { service } });
  return { app, model, keyA, keyB };
}
type Ctx = ReturnType<typeof setup>;

async function ask(c: Ctx, message: string, key = c.keyA, origin = ORIGIN_A) {
  const s = await request(c.app).post(`/v1/chat/${key}/sessions`).set("Origin", origin).send({});
  return request(c.app).post(`/v1/chat/${key}/messages`).set("Origin", origin).set("Authorization", `Bearer ${s.body.sessionToken}`).send({ message });
}
/** What the model saw as the result of its first tool call. */
const toolResult = (c: Ctx, call = 1) => JSON.parse((c.model.calls.at(call)!.messages.at(-1) as { content: string }).content);
const toolText = (c: Ctx) => JSON.stringify(c.model.calls[1]!.messages.filter((m) => m.role === "tool"));

describe("get_policy", () => {
  it("answers from a PUBLISHED policy", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "pets" })) : finalAnswer("Small dogs are welcome on our terrace.")));
    const res = await ask(c, "Can I bring my dog?");
    expect(res.body).toMatchObject({ type: "answer", message: "Small dogs are welcome on our terrace." });
    expect(toolResult(c)).toEqual({ found: true, kind: "pets", title: "Pets policy", body: "Small dogs are welcome on the terrace only." });
  });

  it("never exposes a DRAFT policy; the customer gets the phone number if the model answers anyway", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "cancellation" })) : finalAnswer("You can cancel for free at any time.")));
    const res = await ask(c, "What is your cancellation policy?");
    expect(toolResult(c)).toEqual({ found: false });
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information", contactPhone: "+12685550100" });
    expect(res.body.message).toContain("+1 268 555 0100");
    expect(res.body.message).not.toContain("free at any time");
  });

  it("rejects an unknown kind and ignores a made-up restaurantId", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "free_drinks" })) : finalAnswer("ok")));
    await ask(c, "Hi");
    expect(toolResult(c)).toEqual({ error: "invalid_arguments" });

    const d = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "pets", restaurantId: "rest_002" })) : finalAnswer("Small dogs are welcome on the terrace.")));
    await ask(d, "Are pets allowed?");
    expect(toolText(d)).toContain("Small dogs");
    expect(toolText(d)).not.toContain("No animals");
  });

  it("allows amounts that the published policy itself states, and still blocks invented ones", async () => {
    const ok = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "corkage" })) : finalAnswer("Corkage is $25 per bottle.")));
    expect((await ask(ok, "Do you charge corkage?")).body).toMatchObject({ type: "answer" });

    const bad = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "corkage" })) : finalAnswer("Corkage is $15 per bottle.")));
    expect((await ask(bad, "Do you charge corkage?")).body).toMatchObject({ type: "contact", reason: "unverified_information" });
  });
});

describe("search_faq", () => {
  it("finds a published FAQ and answers from it", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "is there wifi" })) : finalAnswer("Yes, just ask your server for the password.")));
    const res = await ask(c, "Is there wifi?");
    expect(res.body.type).toBe("answer");
    expect(toolResult(c)).toEqual({ found: true, entries: [{ question: "Do you have free WiFi?", answer: "Yes, ask your server for the password." }] });
  });

  it("never returns drafts or archived entries", async () => {
    for (const query of ["live music on Friday", "happy hour"]) {
      const c = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query })) : finalAnswer("Yes!")));
      await ask(c, query);
      expect(toolResult(c)).toEqual({ found: false });
    }
  });

  it("returns found=false for questions nobody has written an answer to", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "do you sell gift vouchers" })) : finalAnswer("Yes we do.")));
    await ask(c, "Do you sell gift vouchers?"); // not a policy topic: the prompt, not a code guard, keeps the model honest here
    expect(toolResult(c)).toEqual({ found: false });
  });

  it("amounts quoted from an FAQ are grounded; other amounts are not", async () => {
    const ok = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "birthday cake" })) : finalAnswer("Yes, cakes cost $45 and need 48 hours notice.")));
    expect((await ask(ok, "Can I get a birthday cake?")).body.type).toBe("answer");
    const bad = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "birthday cake" })) : finalAnswer("Cakes cost $30.")));
    expect((await ask(bad, "Can I get a birthday cake?")).body).toMatchObject({ type: "contact", reason: "unverified_information" });
  });

  it("validates its arguments", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "x" })) : finalAnswer("ok")));
    await ask(c, "Hi");
    expect(toolResult(c)).toEqual({ error: "invalid_arguments" });
  });
});

describe("policy-topic guard", () => {
  it("replaces an answer about a policy topic that no knowledge tool backed up", async () => {
    const c = setup(() => finalAnswer("Yes, dogs are welcome everywhere!"));
    const res = await ask(c, "Can I bring my dog?");
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information" });
    expect(res.body.message).not.toContain("welcome everywhere");
  });

  it("also catches a lookup that found nothing followed by an answer from memory", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_policy", { kind: "delivery" })) : finalAnswer("Yes, we deliver within 5 km.")));
    expect((await ask(c, "Do you deliver?")).body).toMatchObject({ type: "contact", reason: "unverified_information" });
  });

  it("is language-aware: the Arabic reply carries the phone number too", async () => {
    const c = setup(() => finalAnswer("نعم، نقبل الأطفال."));
    const res = await ask(c, "هل تقبلون الأطفال؟");
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information", contactPhone: "+12685550100" });
    expect(res.body.message).toContain("يرجى الاتصال");
  });

  it("does not interfere with ordinary menu questions that merely contain words like dog or kids", async () => {
    const hotDog = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "hot dog" })) : finalAnswer("The Hot Dog is $9.00.")));
    expect((await ask(hotDog, "Do you have hot dogs?")).body).toMatchObject({ type: "answer" });
    const kids = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "grilled salmon" })) : finalAnswer("The Grilled Salmon is $38.00.")));
    expect((await ask(kids, "My kids love the salmon, how much is it?")).body).toMatchObject({ type: "answer" });
  });
});

describe("tenant isolation of knowledge", () => {
  it("each restaurant's assistant only ever sees its own FAQs and policies", async () => {
    const script = (i: number) => (i === 0 ? callTools(toolCall("search_faq", { query: "wifi" }), toolCall("get_policy", { kind: "pets" }, "call_2")) : finalAnswer("See above."));
    const a = setup(script);
    await ask(a, "wifi and pets?");
    expect(toolText(a)).toContain("ask your server");
    expect(toolText(a)).toContain("Small dogs");
    expect(toolText(a)).not.toContain("No WiFi");
    expect(toolText(a)).not.toContain("No animals");

    const b = setup(script);
    await ask(b, "wifi and pets?", b.keyB, ORIGIN_B);
    expect(toolText(b)).toContain("No WiFi");
    expect(toolText(b)).toContain("No animals");
    expect(toolText(b)).not.toContain("ask your server");
    expect(toolText(b)).not.toContain("Small dogs");
  });
});

describe("tool and prompt wiring", () => {
  it("exposes both tools, with no restaurant id parameter anywhere", () => {
    const names = TOOL_SPECS.map((t) => t.name);
    expect(names).toContain("get_policy");
    expect(names).toContain("search_faq");
    expect(JSON.stringify(TOOL_SPECS)).not.toMatch(/restaurant_?id/i);
    const policy = TOOL_SPECS.find((t) => t.name === "get_policy")!;
    expect((policy.parameters as { properties: { kind: { enum: string[] } } }).properties.kind.enum).toEqual([...POLICY_KINDS]);
  });

  it("tells the model to use them and to fall back to the contact number", () => {
    const prompt = buildSystemPrompt({ restaurantId: "rest_001", name: "Harbor Grill", timezone: "America/Antigua", currency: "USD", defaultLocale: "en", monthlyAiBudgetMicros: 0 } as never, NOW);
    expect(prompt).toContain("get_policy");
    expect(prompt).toContain("search_faq");
    expect(prompt).toContain("unverified_information");
  });
});
