// dashboard/api/_lib/et-time.ts
//
// DST-aware helpers for "wall clock time in America/New_York" math.
// Closes the Phase 2 follow-up where grade-cron used fixed T20:00:00Z
// for "4 PM ET", which was an hour off during EST (Nov–Mar).
//
// Uses Intl.DateTimeFormat with timeZoneName: 'shortOffset' to read the
// effective UTC offset at any given instant, then translates ET wall-clock
// inputs to UTC Dates correctly.

/** Returns the offset (in minutes, signed) of America/New_York at the given instant.
 *  EDT = -240 min (UTC-4), EST = -300 min (UTC-5). */
export function etOffsetMinutes(at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const parts = fmt.formatToParts(at);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  // tz looks like "GMT-4", "GMT-5", or sometimes "GMT" (no offset for UTC zones,
  // but ET is never UTC). Be defensive.
  const m = /GMT([+-]\d+)/.exec(tz);
  if (!m) return -300; // fallback to EST
  return parseInt(m[1], 10) * 60;
}

/**
 * Build a UTC Date for a given ET wall-clock time (year, month 1-12, day 1-31, hour 0-23, minute 0-59).
 *
 * Strategy: form a guess UTC instant from the inputs, ask Intl what offset
 * America/New_York uses at that instant, then subtract the offset to get the
 * actual UTC. This produces correct results across DST boundaries because
 * the offset is read AT the relevant instant, not assumed.
 */
export function etDateAt(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMin = etOffsetMinutes(new Date(guessUtc));
  return new Date(guessUtc - offsetMin * 60_000);
}

/** Returns a UTC Date corresponding to today's ET wall-clock at the given hour:minute. */
export function etTodayAt(hour: number, minute = 0): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date());
  const y = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const d = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
  return etDateAt(y, m, d, hour, minute);
}

export function isAfterEtNow(d: Date): boolean {
  return d.getTime() > Date.now();
}

export function hoursUntilEt(d: Date): number {
  return (d.getTime() - Date.now()) / 3_600_000;
}
