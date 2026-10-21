import { describe, expect, it } from "vitest";
import { extractAmountsCents, normalizeDigits, ungroundedAmounts } from "../src/ai/guards.js";

describe("price guard: Arabic numerals and currency words", () => {
  it("converts Arabic-Indic and Persian digits and separators", () => {
    expect(normalizeDigits("٣٨٫٥٠")).toBe("38.50");
    expect(normalizeDigits("۱٬۲۰۰")).toBe("1,200");
  });

  it("sees a price written with Arabic digits", () => {
    expect(extractAmountsCents("سعر السلمون ٣٨ دولار")).toEqual([3800]);
    expect(extractAmountsCents("السعر ٣٨٫٥٠ دولار")).toEqual([3850]);
  });

  it("sees an Arabic currency word with Western digits, before or after the number", () => {
    expect(extractAmountsCents("السعر 38 دولار")).toEqual([3800]);
    expect(extractAmountsCents("السعر دولار 38")).toEqual([3800]);
    expect(extractAmountsCents("المنيو 120 ريال")).toEqual([12000]);
  });

  it("still reads the existing Western formats, and 'bucks'", () => {
    expect(extractAmountsCents("It is $38.50 or 40 XCD")).toEqual([3850, 4000]);
    expect(extractAmountsCents("about 20 bucks")).toEqual([2000]);
  });

  it("flags an invented Arabic price but accepts one a tool returned", () => {
    const allowed = new Set([3800]);
    expect(ungroundedAmounts("سعر السلمون ٣٥ دولار", allowed)).toEqual([3500]);
    expect(ungroundedAmounts("سعر السلمون ٣٨ دولار", allowed)).toEqual([]);
  });

  it("does not treat times, dates or quantities as prices", () => {
    expect(extractAmountsCents("نغلق الساعة ١٠ مساءً")).toEqual([]);
    expect(extractAmountsCents("We close at 10 PM on 25 December")).toEqual([]);
  });
});
