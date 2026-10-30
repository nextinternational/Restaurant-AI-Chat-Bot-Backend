import { describe, expect, it } from "vitest";
import { dietaryConflicts, normalizeAllergens, normalizeHours, planMenuPatch } from "../src/domain/catalogRules.js";
import { menuItem, NOW } from "./helpers/memoryChat.js";
import { parseRestaurantId } from "../src/domain/ids.js";

const R = parseRestaurantId("rest_001");
const p = (opens: string, closes: string) => ({ opens, closes });
const week = (days: Record<number, { opens: string; closes: string }[]>) => Object.entries(days).map(([d, periods]) => ({ day: Number(d), periods }));

describe("dietary / allergen consistency", () => {
  it("flags contradictions and ignores compatible labels", () => {
    expect(dietaryConflicts(["vegan"], ["milk", "eggs"])).toEqual([{ tag: "vegan", allergen: "milk" }, { tag: "vegan", allergen: "eggs" }]);
    expect(dietaryConflicts(["halal", "kosher", "dairy_free"], ["fish"])).toEqual([]);
    expect(dietaryConflicts(["gluten_free"], ["cereals_gluten"])).toHaveLength(1);
  });
  it("normalises allergens: deduped and in canonical order", () => {
    expect(normalizeAllergens(["milk", "fish", "milk", "celery"])).toEqual(["celery", "fish", "milk"]);
  });
});

describe("planMenuPatch", () => {
  const base = menuItem({ slug: "salmon", name: "Grilled Salmon", priceCents: 3800, description: "Fresh" }, R);

  it("is a no-op when nothing changes", () => {
    expect(planMenuPatch(base, { priceCents: 3800, name: " Grilled Salmon " }, NOW).changed).toEqual([]);
  });
  it("updates name and its normalised lookup key together, and reports only real changes", () => {
    const plan = planMenuPatch(base, { name: "Salmon Teriyaki", priceCents: 4200 }, NOW);
    expect(plan.changed).toEqual(["name", "priceCents"]);
    expect(plan.set).toMatchObject({ name: "Salmon Teriyaki", nameNormalized: "salmon teriyaki", priceCents: 4200 });
    expect(plan.next.nameNormalized).toBe("salmon teriyaki");
  });
  it("removes a description with null", () => {
    const plan = planMenuPatch(base, { description: null }, NOW);
    expect(plan.unset).toEqual(["description"]);
    expect(plan.next.description).toBeUndefined();
  });
  it("never lets a patch touch allergen data and rejects non-integer money", () => {
    expect(planMenuPatch(base, { available: false }, NOW).next.allergensVerified).toBe(false);
    expect(() => planMenuPatch(base, { priceCents: 38.5 }, NOW)).toThrow();
  });
  it("rejects a dietary label that contradicts VERIFIED allergens, but allows it while unverified", () => {
    const verified = { ...base, allergens: ["milk" as const], allergensVerified: true, allergensVerifiedAt: NOW, allergensVerifiedBy: "x" };
    expect(() => planMenuPatch(verified, { dietaryTags: ["dairy_free"] }, NOW)).toThrowError(/contradicts milk/);
    expect(planMenuPatch({ ...verified, allergensVerified: false }, { dietaryTags: ["dairy_free"] }, NOW).changed).toEqual(["dietaryTags"]);
  });
});

describe("normalizeHours", () => {
  const ok = week({ 1: [p("17:00", "22:00"), p("11:00", "14:00")] });

  it("sorts days, periods and exceptions", () => {
    const h = normalizeHours({
      weekly: [...week({ 5: [p("11:00", "23:00")] }), ...ok],
      exceptions: [{ date: "2026-12-25", closed: true, periods: [] }, { date: "2026-12-24", closed: false, periods: [p("11:00", "15:00")], note: "Eve" }],
    });
    expect(h.weekly.map((d) => d.day)).toEqual([1, 5]);
    expect(h.weekly[0]!.periods[0]!.opens).toBe("11:00");
    expect(h.exceptions.map((e) => e.date)).toEqual(["2026-12-24", "2026-12-25"]);
  });
  it("rejects an all-closed week", () => {
    expect(() => normalizeHours({ weekly: week({ 1: [] }), exceptions: [] })).toThrowError(/at least one opening period/);
    expect(() => normalizeHours({ weekly: [], exceptions: [] })).toThrowError(/at least one/);
  });
  it("rejects overlaps, including a late-night period running into the next opening", () => {
    expect(() => normalizeHours({ weekly: week({ 1: [p("11:00", "15:00"), p("14:00", "20:00")] }), exceptions: [] })).toThrowError(/overlapping/);
    expect(() => normalizeHours({ weekly: week({ 1: [p("18:00", "02:00")], 2: [p("01:00", "05:00")] }), exceptions: [] })).toThrowError(/overlapping/);
    // Saturday night past midnight must not collide with Sunday lunch, but must collide with an early Sunday opening.
    expect(normalizeHours({ weekly: week({ 6: [p("18:00", "01:00")], 0: [p("12:00", "20:00")] }), exceptions: [] }).weekly).toHaveLength(2);
    expect(() => normalizeHours({ weekly: week({ 6: [p("18:00", "02:00")], 0: [p("01:00", "20:00")] }), exceptions: [] })).toThrowError(/overlapping/);
  });
  it("accepts back-to-back periods", () => {
    expect(() => normalizeHours({ weekly: week({ 1: [p("11:00", "15:00"), p("15:00", "20:00")] }), exceptions: [] })).not.toThrow();
  });
  it("validates exceptions: real dates, no duplicates, consistent closed flag", () => {
    const w = ok;
    expect(() => normalizeHours({ weekly: w, exceptions: [{ date: "2026-02-30", closed: true, periods: [] }] })).toThrowError(/calendar date/);
    expect(() => normalizeHours({ weekly: w, exceptions: [{ date: "2026-12-25", closed: true, periods: [] }, { date: "2026-12-25", closed: true, periods: [] }] })).toThrowError(/duplicate/);
    expect(() => normalizeHours({ weekly: w, exceptions: [{ date: "2026-12-25", closed: true, periods: [p("10:00", "11:00")] }] })).toThrowError(/marked closed/);
    expect(() => normalizeHours({ weekly: w, exceptions: [{ date: "2026-12-25", closed: false, periods: [] }] })).toThrowError(/marked open/);
  });
});
