import { z } from "zod";
import type { Logger } from "pino";
import { DIETARY_TAGS, POLICY_KINDS, toAllergenView } from "../domain/schemas.js";
import { rankFaqs } from "../domain/knowledgeRules.js";
import { extractAmountsCents } from "./guards.js";
import { formatMoney, hoursForDate, isIsoDate, isOpenAt, localMoment, upcomingDays } from "../domain/hours.js";
import type { ChatTenantContext } from "../services/chat/gateway.js";
import type { ToolSpec } from "./provider.js";

/**
 * Facts collected while the model works, used by the guards afterwards. Tools are the ONLY source of
 * prices and allergen data the customer may be told; the guards check the final answer against these.
 */
export interface TurnFacts {
  allowedAmountsCents: Set<number>;
  allergenLookups: { found: boolean; verified: boolean }[];
  toolsCalled: string[];
  /** One entry per FAQ / policy lookup: did it return published content? Used by the policy-topic guard. */
  knowledgeLookups: { tool: string; found: boolean }[];
  /** One entry per menu lookup (get_menu_item / list_menu): did it return at least one dish? */
  menuLookups: { found: boolean }[];
  /** Dietary labels (halal, vegan, ...) that a menu tool actually returned this turn. */
  dietaryTagsSeen: Set<string>;
  /** Lower-cased text of every tool result this turn: the only place an ingredient claim can be backed. */
  toolText: string;
}

export function newTurnFacts(): TurnFacts {
  return { allowedAmountsCents: new Set(), allergenLookups: [], toolsCalled: [], knowledgeLookups: [], menuLookups: [], dietaryTagsSeen: new Set(), toolText: "" };
}

export interface ToolContext {
  tenant: ChatTenantContext;
  now: Date;
  facts: TurnFacts;
  logger: Logger;
}

const itemName = z.object({ item_name: z.string().trim().min(1).max(120) });
const listMenuArgs = z.object({
  category: z.string().trim().min(1).max(60).nullable(),
  dietary_tag: z.enum(DIETARY_TAGS).nullable(),
});
const hoursArgs = z.object({ date: z.string().max(10).nullable() });
const faqArgs = z.object({ query: z.string().trim().min(2).max(200) });
const policyArgs = z.object({ kind: z.enum(POLICY_KINDS) });
const noArgs = z.object({});

const str = (description: string) => ({ type: "string", description });
const nullableStr = (description: string) => ({ type: ["string", "null"], description });

/**
 * Note what is NOT in any schema: a restaurant id. The tenant is bound server-side to the session, so
 * the model cannot name another restaurant even if a customer talks it into trying.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_menu_item",
    description: "Look up a dish or drink by name: price, description, availability and dietary labels. Does NOT return allergens.",
    parameters: { type: "object", additionalProperties: false, required: ["item_name"], properties: { item_name: str("Dish name as the customer wrote it") } },
  },
  {
    name: "list_menu",
    description: "List the active menu, optionally filtered by category and/or dietary label. Returns names and prices only.",
    parameters: {
      type: "object", additionalProperties: false, required: ["category", "dietary_tag"],
      properties: { category: nullableStr("Menu category or null for all"), dietary_tag: { type: ["string", "null"], enum: [...DIETARY_TAGS, null] } },
    },
  },
  {
    name: "get_item_allergens",
    description: "Allergen declaration for a dish. Returns verified=false when no human has verified the data. Required before saying anything about allergens or ingredients.",
    parameters: { type: "object", additionalProperties: false, required: ["item_name"], properties: { item_name: str("Dish name") } },
  },
  {
    name: "get_opening_hours",
    description: "Opening hours for a date (restaurant local time) plus the next 7 days and whether it is open right now.",
    parameters: { type: "object", additionalProperties: false, required: ["date"], properties: { date: nullableStr("YYYY-MM-DD, or null for today") } },
  },
  {
    name: "get_policy",
    description: "The restaurant's published policy of one kind (cancellation, refund, dress code, children, pets, payment, delivery, takeaway, corkage, parking, accessibility, private events, service charge). found=false means it is not published: do not guess.",
    parameters: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: [...POLICY_KINDS], description: "Policy kind" } } },
  },
  {
    name: "search_faq",
    description: "Search the restaurant's published FAQ for any general question not covered by the other tools. Returns up to 3 entries; use one only if it clearly answers the customer. found=false means there is no published answer: do not guess.",
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: str("The customer's question, short and in their own words") } },
  },
  {
    name: "get_location",
    description: "Address, map link and notes of the restaurant. It never includes a phone number.",
    parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
  },
];

function json(value: unknown): string {
  return JSON.stringify(value).slice(0, 8000);
}

function parseArgs<T extends z.ZodType>(schema: T, raw: string, tool: string, logger: Logger): z.output<T> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  if (!result.success) return null;
  if (data && typeof data === "object") {
    const known = new Set(Object.keys((schema as unknown as z.ZodObject).shape));
    const extra = Object.keys(data).filter((k) => !known.has(k));
    // Extra keys (for example a made-up restaurantId) are dropped, never honoured.
    if (extra.length > 0) logger.warn({ tool, ignoredArgs: extra }, "model supplied unexpected tool arguments; ignored");
  }
  return result.data;
}

export async function executeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const output = await runTool(name, rawArgs, ctx);
  ctx.facts.toolText = (ctx.facts.toolText + " " + output.toLowerCase()).slice(-60_000);
  return output;
}

async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  ctx.facts.toolsCalled.push(name);
  const bad = json({ error: "invalid_arguments" });
  const { tenant, facts } = ctx;

  switch (name) {
    case "get_menu_item": {
      const args = parseArgs(itemName, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const items = await tenant.menu.findByName(args.item_name);
      facts.menuLookups.push({ found: items.length > 0 });
      if (items.length === 0) return json({ found: false });
      for (const i of items) {
        facts.allowedAmountsCents.add(i.priceCents);
        for (const t of i.dietaryTags) facts.dietaryTagsSeen.add(t);
      }
      return json({
        found: true,
        matches: items.map((i) => ({
          name: i.name, description: i.description ?? null, category: i.category, price: formatMoney(i.priceCents, i.currency),
          priceCents: i.priceCents, currency: i.currency, available: i.available, dietaryLabels: i.dietaryTags,
        })),
      });
    }
    case "list_menu": {
      const args = parseArgs(listMenuArgs, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const all = await tenant.menu.list({ ...(args.category ? { category: args.category } : {}), limit: 100 });
      const items = args.dietary_tag ? all.filter((i) => i.dietaryTags.includes(args.dietary_tag!)) : all;
      facts.menuLookups.push({ found: items.length > 0 });
      for (const i of items) {
        facts.allowedAmountsCents.add(i.priceCents);
        for (const t of i.dietaryTags) facts.dietaryTagsSeen.add(t);
      }
      return json({
        count: items.length,
        items: items.slice(0, 60).map((i) => ({ name: i.name, category: i.category, price: formatMoney(i.priceCents, i.currency), available: i.available })),
      });
    }
    case "get_item_allergens": {
      const args = parseArgs(itemName, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const items = await tenant.menu.findByName(args.item_name);
      if (items.length === 0) {
        facts.allergenLookups.push({ found: false, verified: false });
        return json({ found: false });
      }
      return json({
        found: true,
        matches: items.map((i) => {
          const view = toAllergenView(i);
          facts.allergenLookups.push({ found: true, verified: view.verified });
          return view.verified
            ? { name: i.name, verified: true, declaredAllergens: view.allergens }
            : { name: i.name, verified: false };
        }),
      });
    }
    case "get_opening_hours": {
      const args = parseArgs(hoursArgs, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const tz = tenant.restaurant.timezone;
      const today = localMoment(ctx.now, tz).date;
      const date = args.date ?? today;
      if (!isIsoDate(date)) return bad;
      const hours = await tenant.hours.get();
      if (!hours) return json({ available: false });
      return json({
        timezone: tz,
        today,
        requested: hoursForDate(hours, date),
        ...(date === today ? { openNow: isOpenAt(hours, ctx.now, tz) } : {}),
        next7Days: upcomingDays(ctx.now, tz, 7).map((d) => hoursForDate(hours, d.date)),
      });
    }
    case "get_policy": {
      const args = parseArgs(policyArgs, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const policy = await tenant.knowledge.getPublishedPolicy(args.kind);
      facts.knowledgeLookups.push({ tool: name, found: policy !== null });
      if (!policy) return json({ found: false });
      // Staff-authored, published text is a trusted source for the amounts it mentions (for example a corkage fee).
      for (const c of extractAmountsCents(`${policy.title} ${policy.body}`)) facts.allowedAmountsCents.add(c);
      return json({ found: true, kind: policy.kind, title: policy.title, body: policy.body });
    }
    case "search_faq": {
      const args = parseArgs(faqArgs, rawArgs, name, ctx.logger);
      if (!args) return bad;
      const hits = rankFaqs(args.query, await tenant.knowledge.listPublishedFaqs(), 3);
      facts.knowledgeLookups.push({ tool: name, found: hits.length > 0 });
      if (hits.length === 0) return json({ found: false });
      for (const { faq } of hits) for (const c of extractAmountsCents(`${faq.question} ${faq.answer}`)) facts.allowedAmountsCents.add(c);
      return json({ found: true, entries: hits.map(({ faq }) => ({ question: faq.question, answer: faq.answer, ...(faq.category ? { category: faq.category } : {}) })) });
    }
    case "get_location": {
      if (!noArgs.safeParse(safeJson(rawArgs)).success) return bad;
      const loc = tenant.restaurant.location;
      // The phone number is deliberately left out: only code-owned messages ever state it.
      return json(loc ? { available: true, address: loc.address, ...(loc.mapUrl ? { mapUrl: loc.mapUrl } : {}), ...(loc.notes ? { notes: loc.notes } : {}) } : { available: false });
    }
    default:
      return json({ error: "unknown_tool" });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
