import { describe, it, expect } from "vitest";
import { addDaysIso, formatMoney, hoursForDate, isIsoDate, isOpenAt, localMoment, upcomingDays, weekdayName } from "../src/domain/hours.js";
import { cleanCustomerText, extractAmountsCents, mentionsAllergy, ungroundedAmounts, wantsHuman } from "../src/ai/guards.js";

const hours = {
  weekly: [
    { day: 5, periods: [{ opens: "18:00", closes: "02:00" }] }, // Friday night runs into Saturday
    { day: 6, periods: [{ opens: "10:00", closes: "22:00" }] },
  ],
  exceptions: [{ date: "2026-10-11", closed: true, periods: [], note: "Private event" }],
};

describe("hours", () => {
  it("reads the wall clock in the restaurant timezone, not the server's", () => {
    // 02:30 UTC on Saturday is still Friday 22:30 in Antigua (UTC-4).
    expect(localMoment(new Date("2026-10-10T02:30:00Z"), "America/Antigua")).toEqual({ date: "2026-10-09", weekday: 5, minutes: 22 * 60 + 30 });
    expect(localMoment(new Date("2026-10-10T02:30:00Z"), "Asia/Dubai")).toMatchObject({ date: "2026-10-10", weekday: 6 });
  });

  it("validates dates and does simple date maths", () => {
    expect(isIsoDate("2026-10-10")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "10/10/2026", "2026-1-1", ""]) expect(isIsoDate(bad)).toBe(false);
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayName("2026-10-10")).toBe("Saturday");
    expect(upcomingDays(new Date("2026-10-10T15:00:00Z"), "America/Antigua", 3).map((d) => d.weekday)).toEqual(["Saturday", "Sunday", "Monday"]);
  });

  it("exceptions override the weekly schedule and carry their note", () => {
    expect(hoursForDate(hours, "2026-10-10")).toMatchObject({ closed: false, periods: [{ opens: "10:00", closes: "22:00", closesNextDay: false }] });
    expect(hoursForDate(hours, "2026-10-11")).toMatchObject({ closed: true, periods: [], note: "Private event" });
    expect(hoursForDate(hours, "2026-10-12").closed).toBe(true); // no schedule = closed
  });

  it("knows when it is open, including after-midnight spill from the previous day", () => {
    const at = (iso: string) => isOpenAt(hours, new Date(iso), "America/Antigua");
    expect(at("2026-10-10T15:00:00Z")).toBe(true); // Sat 11:00
    expect(at("2026-10-10T09:00:00Z")).toBe(false); // Sat 05:00
    expect(at("2026-10-10T05:00:00Z")).toBe(true); // Sat 01:00, Friday's late period
    expect(at("2026-10-10T07:00:00Z")).toBe(false); // Sat 03:00, past 02:00 close
    expect(at("2026-10-10T23:00:00Z")).toBe(true); // Sat 19:00
  });

  it("formats money from integer cents", () => {
    expect(formatMoney(3800, "USD")).toBe("$38.00");
    expect(formatMoney(5, "USD")).toBe("$0.05");
  });
});

describe("guards", () => {
  it("detects an explicit request for a person, not casual mentions", () => {
    for (const yes of ["Can I speak to a human?", "I want to talk to someone", "let me talk to the manager", "real person please", "أريد التحدث مع موظف"]) {
      expect(wantsHuman(yes), yes).toBe(true);
    }
    for (const no of ["What time do you open?", "Is the manager's special available?", "How much is the salmon"]) {
      expect(wantsHuman(no), no).toBe(false);
    }
  });

  it("flags allergy and intolerance talk in English and Arabic", () => {
    for (const yes of ["I'm allergic to peanuts", "is it gluten free?", "any dairy?", "cross-contamination risk", "عندي حساسية من المكسرات"]) {
      expect(mentionsAllergy(yes), yes).toBe(true);
    }
    for (const no of ["How much is the salmon?", "Where are you located?"]) expect(mentionsAllergy(no), no).toBe(false);
  });

  it("extracts amounts in several notations", () => {
    expect(extractAmountsCents("It is $38.00 or $38, EC$40 or XCD 1,200.50, also 12 dollars and 7.5 USD.")).toEqual(
      expect.arrayContaining([3800, 4000, 120050, 1200, 750]),
    );
    expect(extractAmountsCents("Price is $38.")).toEqual([3800]);
    expect(extractAmountsCents("Open 2 hours, table for 4, since 1998")).toEqual([]);
  });

  it("only grounded amounts pass", () => {
    const allowed = new Set([3800, 1250]);
    expect(ungroundedAmounts("The salmon is $38.00 and the soup $12.50.", allowed)).toEqual([]);
    expect(ungroundedAmounts("The salmon is $35.", allowed)).toEqual([3500]);
    expect(ungroundedAmounts("Two salmons come to $76.", allowed)).toEqual([7600]);
    expect(ungroundedAmounts("We open at 10.", allowed)).toEqual([]);
  });

  it("cleans control characters from customer text", () => {
    expect(cleanCustomerText("  hi\u0000 there\u0007  ")).toBe("hi there");
  });
});
