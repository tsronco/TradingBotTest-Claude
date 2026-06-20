// dashboard/src/lib/market-status.ts
//
// Pure, dependency-free NYSE market-status helper for the header clock.
//
// Answers "is the U.S. stock market open right now?" taking into account:
//   - the time of day in Eastern Time (regular session 9:30 AM – 4:00 PM ET)
//   - the day of the week (closed Sat/Sun)
//   - full-closure holidays (with NYSE observed-date shifts)
//   - half-days (1:00 PM ET early close: day after Thanksgiving, Christmas
//     Eve, July 3 before Independence Day)
//
// This is a self-contained baseline so the header renders instantly and works
// offline in the installed PWA. When an authoritative Alpaca `/clock` payload
// is available (it natively handles holidays, half-days, AND rare ad-hoc
// closures like a national day of mourning), pass it as the second arg to
// `computeMarketStatus` and it overrides the open/closed verdict — the local
// calendar still supplies the date label and a human-readable reason.

export interface AlpacaClock {
  is_open: boolean;
  next_open?: string;
  next_close?: string;
  timestamp?: string;
}

export interface MarketStatus {
  /** True when the regular session is currently open (incl. half-days until 1 PM). */
  isOpen: boolean;
  /** Pill text: 'OPEN', 'OPEN · ½ day', or 'CLOSED'. */
  label: string;
  /** Human-readable reason, e.g. 'Regular session', 'Weekend', 'Juneteenth',
   *  'Pre-market — opens 9:30 AM ET', 'After hours — closed 1:00 PM ET'. */
  reason: string;
  /** True on the NYSE 1:00 PM early-close days. */
  isHalfDay: boolean;
  /** e.g. 'Fri Jun 20'. */
  etDateLabel: string;
  /** e.g. 'Friday'. */
  etDayLabel: string;
}

// ---------------------------------------------------------------------------
// ET wall-clock extraction
// ---------------------------------------------------------------------------

interface EtParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  weekday: number; // 0=Sun … 6=Sat
  minutesOfDay: number; // 0-1439, ET wall clock
}

function etParts(at: Date): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);
  const hour = parseInt(get('hour'), 10) % 24; // h23 can emit '24' at midnight on some engines
  const minute = parseInt(get('minute'), 10);
  // Day-of-week for the ET calendar date, computed independently of the
  // viewer's local timezone via a UTC anchor on that y/m/d.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday, minutesOfDay: hour * 60 + minute };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ---------------------------------------------------------------------------
// Holiday + half-day calendar (algorithmic, with observed-date shifts)
// ---------------------------------------------------------------------------

/** UTC day-of-week (0=Sun) for a calendar date. */
function dowOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The date of the nth given weekday in a month (1-indexed n). */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = dowOf(year, month, 1);
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** The date of the last given weekday in a month. */
function lastWeekday(year: number, month: number, weekday: number): number {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = dowOf(year, month, daysInMonth);
  const offset = (lastDow - weekday + 7) % 7;
  return daysInMonth - offset;
}

/** Easter Sunday (Gregorian / Anonymous computus). Returns {month, day}. */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Apply an offset of `delta` days to a y/m/d via a UTC anchor. */
function shiftDate(year: number, month: number, day: number, delta: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(year, month - 1, day + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Observed date for a fixed-date holiday. NYSE shifts Saturday holidays to the
 * preceding Friday and Sunday holidays to the following Monday — EXCEPT New
 * Year's Day, which only shifts forward (Sun→Mon); a Saturday Jan 1 is simply
 * not observed (the market does not close the prior Dec 31).
 */
function observedDate(
  year: number,
  month: number,
  day: number,
  newYears = false
): { y: number; m: number; d: number } | null {
  const dow = dowOf(year, month, day);
  if (dow === 6) {
    // Saturday
    if (newYears) return null;
    return shiftDate(year, month, day, -1);
  }
  if (dow === 0) {
    // Sunday
    return shiftDate(year, month, day, 1);
  }
  return { y: year, m: month, d: day };
}

/** Map of 'YYYY-MM-DD' → holiday display name for full-closure NYSE holidays. */
export function nyseHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const add = (o: { y: number; m: number; d: number } | null, name: string) => {
    if (o) out.set(ymd(o.y, o.m, o.d), name);
  };

  add(observedDate(year, 1, 1, true), "New Year's Day");
  add({ y: year, m: 1, d: nthWeekday(year, 1, 1, 3) }, 'Martin Luther King Jr. Day');
  add({ y: year, m: 2, d: nthWeekday(year, 2, 1, 3) }, "Presidents' Day");

  const easter = easterSunday(year);
  const goodFri = shiftDate(year, easter.month, easter.day, -2);
  add(goodFri, 'Good Friday');

  add({ y: year, m: 5, d: lastWeekday(year, 5, 1) }, 'Memorial Day');
  if (year >= 2022) add(observedDate(year, 6, 19), 'Juneteenth');
  add(observedDate(year, 7, 4), 'Independence Day');
  add({ y: year, m: 9, d: nthWeekday(year, 9, 1, 1) }, 'Labor Day');
  add({ y: year, m: 11, d: nthWeekday(year, 11, 4, 4) }, 'Thanksgiving');
  add(observedDate(year, 12, 25), 'Christmas');

  return out;
}

/**
 * Map of 'YYYY-MM-DD' → label for NYSE 1:00 PM early-close days. A date that is
 * also a full holiday (e.g. a Friday Christmas-Eve that is the observed
 * Christmas) is omitted here — the full-closure calendar takes precedence.
 */
export function nyseHalfDays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const holidays = nyseHolidays(year);
  const addIfTradingDay = (m: number, d: number, label: string) => {
    const dow = dowOf(year, m, d);
    if (dow === 0 || dow === 6) return; // weekend — not a trading day
    const key = ymd(year, m, d);
    if (holidays.has(key)) return; // full holiday wins
    out.set(key, label);
  };

  // Day after Thanksgiving — 4th Friday of November (Thanksgiving is 4th Thu).
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  addIfTradingDay(11, thanksgiving + 1, 'Day after Thanksgiving');

  // July 3 — early close the day before Independence Day, when it's a trading day.
  addIfTradingDay(7, 3, 'Independence Day eve');

  // December 24 — Christmas Eve, when it's a trading day.
  addIfTradingDay(12, 24, 'Christmas Eve');

  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function etDateLabel(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')}`.trim();
}

function etDayLabel(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  }).format(at);
}

// Regular session minute boundaries (ET).
const OPEN_MIN = 9 * 60 + 30; // 9:30 AM
const REG_CLOSE_MIN = 16 * 60; // 4:00 PM
const HALF_CLOSE_MIN = 13 * 60; // 1:00 PM

function fmtCloseTime(half: boolean): string {
  return half ? '1:00 PM ET' : '4:00 PM ET';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute market status purely from the local NYSE calendar (no network).
 * Exported for testing and for use as the instant/offline baseline.
 */
export function localMarketStatus(now: Date): MarketStatus {
  const { year, month, day, weekday, minutesOfDay } = etParts(now);
  const dateLabel = etDateLabel(now);
  const dayLabel = etDayLabel(now);
  const key = ymd(year, month, day);

  const base = {
    etDateLabel: dateLabel,
    etDayLabel: dayLabel,
  };

  // Weekend.
  if (weekday === 0 || weekday === 6) {
    return { ...base, isOpen: false, label: 'CLOSED', reason: 'Weekend', isHalfDay: false };
  }

  // Full holiday.
  const holidayName = nyseHolidays(year).get(key);
  if (holidayName) {
    return { ...base, isOpen: false, label: 'CLOSED', reason: holidayName, isHalfDay: false };
  }

  // Half-day?
  const halfDayLabel = nyseHalfDays(year).get(key);
  const isHalfDay = Boolean(halfDayLabel);
  const closeMin = isHalfDay ? HALF_CLOSE_MIN : REG_CLOSE_MIN;

  if (minutesOfDay < OPEN_MIN) {
    return {
      ...base,
      isOpen: false,
      label: 'CLOSED',
      reason: 'Pre-market — opens 9:30 AM ET',
      isHalfDay,
    };
  }
  if (minutesOfDay >= closeMin) {
    return {
      ...base,
      isOpen: false,
      label: 'CLOSED',
      reason: `After hours — closed ${fmtCloseTime(isHalfDay)}`,
      isHalfDay,
    };
  }

  // Open.
  return {
    ...base,
    isOpen: true,
    label: isHalfDay ? 'OPEN · ½ day' : 'OPEN',
    reason: isHalfDay ? `${halfDayLabel} — early close 1:00 PM ET` : 'Regular session',
    isHalfDay,
  };
}

/** ET hour (0-23) of an ISO instant, or null if unparseable. */
function etHourOf(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(d)
    .find((p) => p.type === 'hour')?.value;
  return h != null ? parseInt(h, 10) % 24 : null;
}

/**
 * Compute market status, preferring an authoritative Alpaca `/clock` payload
 * when supplied. The clock decides open/closed (it knows holidays, half-days,
 * and ad-hoc closures); the local calendar supplies the date label and the
 * best available human-readable reason.
 */
export function computeMarketStatus(now: Date, clock?: AlpacaClock | null): MarketStatus {
  const local = localMarketStatus(now);
  if (!clock || typeof clock.is_open !== 'boolean') return local;

  // Half-day detection from the clock: when open, today's close lands at 1 PM ET.
  const closeHour = clock.next_close ? etHourOf(clock.next_close) : null;
  const clockHalfDay = clock.is_open && closeHour === 13;
  const isHalfDay = clockHalfDay || (clock.is_open && local.isHalfDay);

  if (clock.is_open) {
    return {
      ...local,
      isOpen: true,
      isHalfDay,
      label: isHalfDay ? 'OPEN · ½ day' : 'OPEN',
      reason: isHalfDay
        ? local.isHalfDay
          ? local.reason
          : 'Early close — 1:00 PM ET'
        : 'Regular session',
    };
  }

  // Clock says closed. Keep the local reason when it already explains the
  // closure (weekend / holiday / pre-market / after-hours); otherwise the
  // local calendar thought we were open, so this is an unexpected/ad-hoc
  // closure (e.g. a national day of mourning).
  const reason = local.isOpen ? 'Market closed' : local.reason;
  return { ...local, isOpen: false, label: 'CLOSED', reason };
}
