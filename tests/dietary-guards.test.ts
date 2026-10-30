import { describe, it, expect } from "vitest";
import request from "supertest";
import pino from "pino";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { dietaryTermsIn, sensitiveIngredientsIn } from "../src/ai/guards.js";
import { ChatService, type ChatConfig } from "../src/services/chat/chatService.js";
import { MemoryChatGateway, NOW, ScriptedModel, callTools, finalAnswer, toolCall } from "./helpers/memoryChat.js";

const logger = pino({ level: "silent" });
const ORIGIN = "https://harbor.example";
const config: ChatConfig = {
  maxMessagesPerConversation: 100, defaultMonthlyBudgetMicros: 10_000_000, price: { inputMicrosPerMtok: 150_000, outputMicrosPerMtok: 600_000 },
  timeoutMs: 5000, maxToolIterations: 4, historyLimit: 10,
};

function setup(script: ConstructorParameters<typeof ScriptedModel>[0], extra: Partial<ChatConfig> = {}, clock: () => Date = () => NOW) {
  const gateway = new MemoryChatGateway();
  const key = gateway.addTenant({
    restaurantId: "rest_001", name: "Harbor Grill", origin: ORIGIN, location: { address: "1 Beach Road", phone: "+1 268 555 0100" },
    items: [
      { slug: "veg-pasta", name: "Veg Pasta", priceCents: 2200, dietaryTags: ["vegetarian", "halal"] },
      { slug: "ham-sandwich", name: "Ham Sandwich", priceCents: 1500, description: "Smoked ham and cheddar" },
      { slug: "salmon", name: "Grilled Salmon", priceCents: 3800 },
    ],
    faqs: [{ slug: "alcohol", question: "Do you serve alcohol?", answer: "Yes, we serve beer and wine with meals." }],
  });
  const env = loadEnv({
    NODE_ENV: "test", MONGODB_URI: "mongodb://localhost:27017", MONGODB_DB_NAME: "t", RATE_LIMIT_GLOBAL_PER_MIN: "10000",
    CHAT_SESSIONS_PER_IP_HOUR: "1000", CHAT_SESSIONS_PER_KEY_HOUR: "1000", CHAT_MESSAGES_PER_SESSION_MIN: "1000", CHAT_MESSAGES_PER_KEY_MIN: "1000",
  });
  const service = new ChatService(gateway, new ScriptedModel(script), { ...config, ...extra }, logger, clock);
  const app = createApp({ env, logger, readinessChecks: [], chat: { service } });
  const session = async () => (await request(app).post(`/v1/chat/${key}/sessions`).set("Origin", ORIGIN).send({})).body.sessionToken as string;
  const say = (token: string, message: string) => request(app).post(`/v1/chat/${key}/messages`).set("Origin", ORIGIN).set("Authorization", `Bearer ${token}`).send({ message });
  return { session, say };
}

describe("dietary term detection", () => {
  it("finds English and Arabic labels", () => {
    expect(dietaryTermsIn("Is the lamb halal?")).toEqual(["halal"]);
    expect(dietaryTermsIn("هل الطبق حلال؟")).toEqual(["halal"]);
    expect(dietaryTermsIn("Do you have vegan and gluten-free options?")).toEqual(expect.arrayContaining(["vegan", "gluten_free"]));
    expect(dietaryTermsIn("How much is the salmon?")).toEqual([]);
  });
  it("finds pork, alcohol and gelatin", () => {
    expect(sensitiveIngredientsIn("Does it contain pork or alcohol?")).toEqual(["pork", "alcohol"]);
    expect(sensitiveIngredientsIn("هل فيه لحم خنزير؟")).toEqual(["خنزير"]);
    expect(sensitiveIngredientsIn("Where is the restaurant?")).toEqual([]);
  });
});

describe("dietary and religious claims are never guessed", () => {
  it("sends a halal question to the phone number when no dish was looked up", async () => {
    const c = setup(() => finalAnswer("Yes, all our dishes are halal."));
    const res = await c.say(await c.session(), "Is your food halal?");
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information" });
    expect(res.body.message).toContain("+1 268 555 0100");
  });

  it("blocks a halal claim for a dish that does not carry the label", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "grilled salmon" })) : finalAnswer("The Grilled Salmon is halal.")));
    const res = await c.say(await c.session(), "Is the grilled salmon halal?");
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information" });
  });

  it("allows the label when the menu tool returned it for the dish", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "veg pasta" })) : finalAnswer("Yes, the Veg Pasta is labelled halal and vegetarian.")));
    const res = await c.say(await c.session(), "Is the veg pasta halal?");
    expect(res.body).toMatchObject({ type: "answer" });
  });

  it("blocks a pork-free promise the tools never made", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "grilled salmon" })) : finalAnswer("The salmon contains no pork.")));
    const res = await c.say(await c.session(), "Is there pork in the salmon?");
    expect(res.body).toMatchObject({ type: "contact", reason: "unverified_information" });
  });

  it("still answers an ordinary menu question that names a pork dish, because the tool text says it", async () => {
    const c = setup((i) => (i === 0 ? callTools(toolCall("get_menu_item", { item_name: "ham sandwich" })) : finalAnswer("The Ham Sandwich is $15.")));
    const res = await c.say(await c.session(), "How much is the ham sandwich?");
    expect(res.body).toMatchObject({ type: "answer", message: "The Ham Sandwich is $15." });
  });

  it("answers an alcohol question only from a published FAQ", async () => {
    const withFaq = setup((i) => (i === 0 ? callTools(toolCall("search_faq", { query: "alcohol" })) : finalAnswer("Yes, we serve beer and wine with meals.")));
    expect((await withFaq.say(await withFaq.session(), "Do you serve alcohol?")).body.type).toBe("answer");
    const noLookup = setup(() => finalAnswer("No, we do not serve alcohol."));
    expect((await noLookup.say(await noLookup.session(), "Do you serve alcohol?")).body).toMatchObject({ type: "contact" });
  });
});

describe("idle session expiry", () => {
  it("refuses a session that has been idle longer than the limit", async () => {
    let now = NOW;
    const c = setup(() => finalAnswer("Hello!"), { sessionIdleMs: 12 * 3_600_000 }, () => now);
    const token = await c.session();
    expect((await c.say(token, "hi")).status).toBe(200);
    now = new Date(NOW.getTime() + 13 * 3_600_000);
    const res = await c.say(token, "hi again");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_session");
  });

  it("keeps an active session alive", async () => {
    let now = NOW;
    const c = setup(() => finalAnswer("Hello!"), { sessionIdleMs: 12 * 3_600_000 }, () => now);
    const token = await c.session();
    for (let i = 0; i < 3; i++) {
      now = new Date(now.getTime() + 8 * 3_600_000);
      expect((await c.say(token, "still here")).status).toBe(200);
    }
  });
});
