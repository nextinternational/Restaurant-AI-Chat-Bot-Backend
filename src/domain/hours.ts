import type { OpeningHours } from "./schemas.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT = new Map<string, number>([["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]]);

export interface LocalMoment {
  /** YYYY-MM-DD in the restaurant's timezone. */
  date: string;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

/** Wall-clock date/time in an IANA timezone. Server timezone never matters. */
export function localMoment(now: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: SHORT.get(get("weekday")) ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export function addDaysIso(date: string, days: number): string {
  const m = ISO_DATE.exec(date)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const m = ISO_DATE.exec(date)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export function weekdayName(date: string): string {
  return WEEKDAYS[weekdayOf(date)]!;
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface DayPeriod {
  opens: string;
  closes: string;
  closesNextDay: boolean;
}

export interface DayHours {
  date: string;
  weekday: string;
  closed: boolean;
  periods: DayPeriod[];
  note?: string;
}

/** Exceptions (holidays) override the weekly schedule for their date. */
export function hoursForDate(hours: Pick<OpeningHours, "weekly" | "exceptions">, date: string): DayHours {
  const exception = hours.exceptions.find((e) => e.date === date);
  const raw = exception
    ? exception.closed ? [] : exception.periods
    : hours.weekly.find((d) => d.day === weekdayOf(date))?.periods ?? [];
  const periods = raw.map((p) => ({ opens: p.opens, closes: p.closes, closesNextDay: toMinutes(p.closes) <= toMinutes(p.opens) }));
  return {
    date,
    weekday: weekdayName(date),
    closed: periods.length === 0,
    periods,
    ...(exception?.note ? { note: exception.note } : {}),
  };
}

/** Handles periods that run past midnight (closes <= opens) by also checking yesterday's schedule. */
export function isOpenAt(hours: Pick<OpeningHours, "weekly" | "exceptions">, now: Date, timeZone: string): boolean {
  const local = localMoment(now, timeZone);
  for (const p of hoursForDate(hours, local.date).periods) {
    const o = toMinutes(p.opens);
    const c = toMinutes(p.closes);
    if (p.closesNextDay ? local.minutes >= o : local.minutes >= o && local.minutes < c) return true;
  }
  for (const p of hoursForDate(hours, addDaysIso(local.date, -1)).periods) {
    if (p.closesNextDay && local.minutes < toMinutes(p.closes)) return true;
  }
  return false;
}

export function upcomingDays(now: Date, timeZone: string, count: number): { date: string; weekday: string }[] {
  const today = localMoment(now, timeZone).date;
  return Array.from({ length: count }, (_, i) => {
    const date = addDaysIso(today, i);
    return { date, weekday: weekdayName(date) };
  });
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
