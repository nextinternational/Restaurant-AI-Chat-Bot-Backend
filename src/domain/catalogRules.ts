import { AppError } from "../errors.js";
import { normalizeName } from "../repositories/normalize.js"; // pure helper, no I/O
import { isIsoDate } from "./hours.js";
import {
  ALLERGENS, menuItemSchema, type Allergen, type DIETARY_TAGS, type MenuItem, type OpeningHours,
} from "./schemas.js";

/**
 * Pure business rules for the menu / opening-hours management API (Step 7).
 * No I/O here, so the repository, the service and the in-memory test double all share ONE implementation.
 */

type DietaryTag = (typeof DIETARY_TAGS)[number];

/** A dietary label that contradicts a verified allergen is a customer-safety bug, so it is rejected, not warned about. */
export const DIETARY_ALLERGEN_CONFLICTS: ReadonlyMap<DietaryTag, readonly Allergen[]> = new Map<DietaryTag, readonly Allergen[]>([
  ["vegetarian", ["fish", "crustaceans", "molluscs"]],
  ["vegan", ["milk", "eggs", "fish", "crustaceans", "molluscs"]],
  ["dairy_free", ["milk"]],
  ["gluten_free", ["cereals_gluten"]],
  ["halal", []],
  ["kosher", []],
]);

export function dietaryConflicts(
  tags: readonly DietaryTag[],
  allergens: readonly Allergen[],
): { tag: DietaryTag; allergen: Allergen }[] {
  const present = new Set(allergens);
  return tags.flatMap((tag) => (DIETARY_ALLERGEN_CONFLICTS.get(tag) ?? []).filter((a) => present.has(a)).map((allergen) => ({ tag, allergen })));
}

function assertNoDietaryConflict(tags: readonly DietaryTag[], allergens: readonly Allergen[]): void {
  const conflicts = dietaryConflicts(tags, allergens);
  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.tag} contradicts ${c.allergen}`).join("; ");
    throw new AppError(422, "allergen_tag_conflict", `Dietary labels conflict with the allergen declaration: ${detail}`);
  }
}

/** Dedupes and orders allergens canonically so the same declaration always stores (and audits) identically. */
export function normalizeAllergens(allergens: readonly Allergen[]): Allergen[] {
  const set = new Set(allergens);
  return ALLERGENS.filter((a) => set.has(a));
}

/** Throws 422 when `allergens` contradicts the item's existing dietary labels. */
export function assertAllergensCompatible(item: Pick<MenuItem, "dietaryTags">, allergens: readonly Allergen[]): void {
  assertNoDietaryConflict(item.dietaryTags, allergens);
}

export interface MenuItemPatch {
  name?: string;
  /** `null` removes the description. */
  description?: string | null;
  category?: string;
  priceCents?: number;
  available?: boolean;
  dietaryTags?: DietaryTag[];
}

export interface MenuPatchPlan {
  /** The validated document as it will look after the update. */
  next: MenuItem;
  /** Fields for `$set` / `$unset`; only what really changed. */
  set: Record<string, unknown>;
  unset: string[];
  /** Public field names that changed (used for the audit trail). Empty = the patch was a no-op. */
  changed: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Applies a partial update to an existing item, re-validates the WHOLE document against the domain schema
 * and checks dietary labels against verified allergens. Allergen data itself can never change through here:
 * it only changes through the explicit, attested verification flow.
 */
export function planMenuPatch(current: MenuItem, patch: MenuItemPatch, now: Date): MenuPatchPlan {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  const changed: string[] = [];
  const next: Record<string, unknown> = { ...current };

  if (patch.name !== undefined && patch.name.trim() !== current.name) {
    next.name = patch.name.trim();
    next.nameNormalized = normalizeName(next.name as string);
    set.name = next.name;
    set.nameNormalized = next.nameNormalized;
    changed.push("name");
  }
  if (patch.description !== undefined) {
    const wanted = patch.description === null ? undefined : patch.description.trim();
    if (wanted !== current.description) {
      changed.push("description");
      if (wanted === undefined) {
        delete next.description;
        unset.push("description");
      } else {
        next.description = wanted;
        set.description = wanted;
      }
    }
  }
  if (patch.category !== undefined && patch.category.trim() !== current.category) {
    next.category = patch.category.trim();
    set.category = next.category;
    changed.push("category");
  }
  if (patch.priceCents !== undefined && patch.priceCents !== current.priceCents) {
    next.priceCents = patch.priceCents;
    set.priceCents = patch.priceCents;
    changed.push("priceCents");
  }
  if (patch.available !== undefined && patch.available !== current.available) {
    next.available = patch.available;
    set.available = patch.available;
    changed.push("available");
  }
  if (patch.dietaryTags !== undefined) {
    const tags = [...new Set(patch.dietaryTags)];
    if (!sameSet(tags, current.dietaryTags)) {
      next.dietaryTags = tags;
      set.dietaryTags = tags;
      changed.push("dietaryTags");
    }
  }

  if (changed.length === 0) return { next: current, set: {}, unset: [], changed: [] };

  next.updatedAt = now;
  set.updatedAt = now;
  const parsed = menuItemSchema.parse(next);
  if (parsed.allergensVerified) assertNoDietaryConflict(parsed.dietaryTags, parsed.allergens);
  return { next: parsed, set, unset, changed };
}

// ---------------------------------------------------------------------------------------- opening hours
export interface HoursInput {
  weekly: { day: number; periods: { opens: string; closes: string }[] }[];
  exceptions: { date: string; closed: boolean; periods: { opens: string; closes: string }[]; note?: string | undefined }[];
}
export type NormalizedHours = Pick<OpeningHours, "weekly" | "exceptions">;

const invalid = (message: string) => new AppError(422, "invalid_hours", message);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const WEEK = 7 * 1440;

/** [start, end) in minutes; a period whose closing time is <= its opening time runs past midnight. */
function interval(p: { opens: string; closes: string }, dayOffset: number): [number, number] {
  const s = toMinutes(p.opens);
  let e = toMinutes(p.closes);
  if (e <= s) e += 1440;
  return [dayOffset + s, dayOffset + e];
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

/**
 * Validates and canonicalises a full schedule (sorted days, sorted periods, sorted exceptions).
 * Rejected with 422 (a well-formed request that describes an impossible or dangerous schedule):
 *  - overlapping periods, including a late-night period that runs into the next day's opening, wrapping Saturday -> Sunday;
 *  - exceptions that are not real calendar dates, or that repeat a date;
 *  - an exception marked closed that still has periods, or marked open with none;
 *  - a weekly schedule with no opening period at all (almost always a data-entry mistake that would tell
 *    every customer "we are closed" all week).
 */
export function normalizeHours(input: HoursInput): NormalizedHours {
  const weekly = [...input.weekly]
    .sort((a, b) => a.day - b.day)
    .map((d) => ({ day: d.day, periods: [...d.periods].sort((a, b) => toMinutes(a.opens) - toMinutes(b.opens)) }));

  if (new Set(weekly.map((d) => d.day)).size !== weekly.length) throw invalid("duplicate day in weekly schedule");
  if (!weekly.some((d) => d.periods.length > 0)) throw invalid("the weekly schedule must contain at least one opening period");

  const week = weekly.flatMap((d) => d.periods.map((p) => ({ day: d.day, iv: interval(p, d.day * 1440) })));
  for (const [i, a] of week.entries()) {
    for (const b of week.slice(i + 1)) {
      // Compare on a circular week: the second interval is also tried one week earlier/later.
      if ([-WEEK, 0, WEEK].some((shift) => overlaps(a.iv, [b.iv[0] + shift, b.iv[1] + shift]))) {
        throw invalid(`overlapping periods on day ${a.day} and day ${b.day}`);
      }
    }
  }

  const seen = new Set<string>();
  const exceptions = [...input.exceptions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => {
      if (!isIsoDate(e.date)) throw invalid(`${e.date} is not a real calendar date`);
      if (seen.has(e.date)) throw invalid(`duplicate exception for ${e.date}`);
      seen.add(e.date);
      if (e.closed && e.periods.length > 0) throw invalid(`${e.date} is marked closed but has opening periods`);
      if (!e.closed && e.periods.length === 0) throw invalid(`${e.date} is marked open but has no opening periods`);
      const periods = [...e.periods].sort((a, b) => toMinutes(a.opens) - toMinutes(b.opens));
      const ivs = periods.map((p) => interval(p, 0));
      for (const [i, a] of ivs.entries()) {
        if (ivs.slice(i + 1).some((b) => overlaps(a, b))) throw invalid(`overlapping periods on ${e.date}`);
      }
      return { date: e.date, closed: e.closed, periods, ...(e.note ? { note: e.note } : {}) };
    });

  return { weekly, exceptions };
}
