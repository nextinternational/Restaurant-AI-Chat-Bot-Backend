import { describe, expect, it } from "vitest";
import { normalizeKeywords, planFaqPatch, rankFaqs, searchTokens } from "../src/domain/knowledgeRules.js";
import { mentionsPolicyTopic } from "../src/ai/guards.js";
import type { Faq } from "../src/domain/schemas.js";
import { parseRestaurantId } from "../src/domain/ids.js";

const T = new Date("2026-10-10T15:00:00Z");
const faq = (p: Partial<Faq> & Pick<Faq, "slug" | "question" | "answer">): Faq => ({
  restaurantId: parseRestaurantId("rest_001"), keywords: [], status: "published", publishedAt: T, createdAt: T, updatedAt: T, ...p,
});

const FAQS: Faq[] = [
  faq({ slug: "wifi", question: "Do you have free WiFi?", answer: "Yes, ask your server for the password.", keywords: ["internet", "wi-fi"] }),
  faq({ slug: "birthday", question: "Can you make a birthday cake for us?", answer: "We can prepare a cake with 48 hours notice.", keywords: ["celebration", "anniversary"] }),
  faq({ slug: "dogs", question: "Are dogs allowed on the terrace?", answer: "Small dogs are welcome on the terrace only.", keywords: ["pets", "puppy"] }),
  faq({ slug: "arabic-wifi", question: "هل يوجد واي فاي مجاني؟", answer: "نعم، اسأل النادل عن كلمة المرور.", keywords: ["انترنت"] }),
];

describe("searchTokens", () => {
  it("drops stop words, accents and punctuation, and reduces simple plurals", () => {
    expect(searchTokens("What are the Café's parking options?")).toEqual(["cafe", "parking", "option"]);
  });
  it("handles Arabic: strips the article and diacritics, keeps meaning words", () => {
    expect(searchTokens("هل لديكم الإنترنت؟")).toEqual(["انترنت"]);
  });
  it("returns nothing for stop words only", () => {
    expect(searchTokens("what is the")).toEqual([]);
  });
});

describe("rankFaqs", () => {
  it("finds the right entry from a natural question", () => {
    expect(rankFaqs("is there wifi here?", FAQS).map((r) => r.faq.slug)).toEqual(["wifi"]);
  });
  it("uses staff keywords as synonyms", () => {
    expect(rankFaqs("can I bring my puppy", FAQS)[0]?.faq.slug).toBe("dogs");
    expect(rankFaqs("do you do anniversary celebrations", FAQS)[0]?.faq.slug).toBe("birthday");
  });
  it("finds Arabic entries from Arabic questions", () => {
    expect(rankFaqs("هل عندكم واي فاي؟", FAQS)[0]?.faq.slug).toBe("arabic-wifi");
  });
  it("returns NOTHING rather than a weak guess", () => {
    expect(rankFaqs("do you sell gift vouchers", FAQS)).toEqual([]);
    expect(rankFaqs("what is the", FAQS)).toEqual([]);
    expect(rankFaqs("", FAQS)).toEqual([]);
  });
  it("needs a hit in the question or a keyword; a word that only appears in an answer is not enough", () => {
    // "password" appears only in the WiFi ANSWER.
    expect(rankFaqs("password", FAQS)).toEqual([]);
  });
  it("requires at least half of the query words to be found", () => {
    expect(rankFaqs("wifi terrace helicopter rocket", FAQS)).toEqual([]);
  });
  it("is deterministic and respects the limit and the relative cut-off", () => {
    const many = Array.from({ length: 6 }, (_, i) => faq({ slug: `w${i}`, question: "Is there wifi?", answer: "Yes." }));
    const hits = rankFaqs("wifi", many, 3);
    expect(hits.map((h) => h.faq.slug)).toEqual(["w0", "w1", "w2"]);
    expect(rankFaqs("wifi", many, 3).map((h) => h.faq.slug)).toEqual(hits.map((h) => h.faq.slug));
  });
});

describe("normalizeKeywords / planFaqPatch", () => {
  it("de-duplicates keywords case-insensitively and keeps the first spelling", () => {
    expect(normalizeKeywords(["Kids", " kids ", "Children", "", "CHILDREN"])).toEqual(["Kids", "Children"]);
  });

  const base = faq({ slug: "wifi", question: "Do you have free WiFi?", answer: "Yes.", category: "General", keywords: ["internet"], status: "draft" });
  const later = new Date("2026-10-11T10:00:00Z");

  it("is a no-op when nothing changes", () => {
    const plan = planFaqPatch(base, { question: "  Do you have free WiFi?  ", keywords: ["internet"], category: "General" }, later);
    expect(plan.changed).toEqual([]);
    expect(plan.next).toBe(base);
  });
  it("reports exactly the fields that changed and never touches status", () => {
    const plan = planFaqPatch(base, { answer: "Yes, ask staff.", keywords: ["internet", "wi-fi"] }, later);
    expect(plan.changed).toEqual(["answer", "keywords"]);
    expect(plan.next).toMatchObject({ status: "draft", answer: "Yes, ask staff.", updatedAt: later });
    expect(plan.set).not.toHaveProperty("status");
  });
  it("removes the category with null", () => {
    const plan = planFaqPatch(base, { category: null }, later);
    expect(plan.changed).toEqual(["category"]);
    expect(plan.unset).toEqual(["category"]);
    expect(plan.next.category).toBeUndefined();
  });
  it("re-validates the whole document", () => {
    expect(() => planFaqPatch(base, { answer: "x".repeat(2001) }, later)).toThrow();
    expect(() => planFaqPatch(base, { keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }, later)).toThrow();
  });
});

describe("mentionsPolicyTopic", () => {
  it.each([
    "What is your cancellation policy?", "Can I get a refund?", "Do you allow pets?", "Can I bring my dog?", "Are kids welcome?",
    "Do you take credit cards?", "Is there parking?", "Do you deliver?", "Is it wheelchair accessible?", "Do you charge corkage?",
    "Is there a service charge?", "Do you have a dress code?", "Can we bring our own cake?", "Is the terrace pet friendly?",
    "هل لديكم موقف سيارات؟", "ما هي سياسة الإلغاء؟", "هل تقبلون الأطفال؟",
  ])("flags %s", (text) => expect(mentionsPolicyTopic(text)).toBe(true));

  it.each([
    "How much is the grilled salmon?", "Do you have hot dogs?", "My kids love the salmon, how much is it?", "What time do you close?",
    "Do you have vegetarian options?", "Where are you located?", "Is the Dogfish on the menu today?",
    "Hello!", "كم سعر السلمون؟",
  ])("does not flag %s", (text) => expect(mentionsPolicyTopic(text)).toBe(false));
});
