// Your exit plan vs the bot's stop, for stock trades.
//
// On manual + live the bot (strategy.py) puts a stop on every stock you hold
// at STOP_PCT below your average cost, and sells there. You can also write
// your own stop/target on the order form (optional, added 2026-11-03), so over
// time we can compare which exit would have done better.
//
// Shared by the API (validation) and the client (form hint + trade page) via
// the re-export in src/lib/exit-plan.ts.
//
// KEEP IN SYNC with STOP_PCT in strategy.py (repo root).
export const BOT_STOP_PCT = 0.10;

/** Where the bot's stop sits for a fresh position bought at `entry`. Approximate:
 *  the bot recomputes it from Alpaca's average cost, which moves if it adds
 *  shares on a dip (its ladder) or you add to the position. */
export function botStopFor(entry: number): number | null {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return Math.round(entry * (1 - BOT_STOP_PCT) * 100) / 100;
}

/** Problems with a typed-in plan, for a buy (long) or sell_short. Both fields
 *  are optional; only a value that is present AND wrong is reported. */
export function exitPlanProblems(
  side: string,
  stop: number | null | undefined,
  target: number | null | undefined,
): string[] {
  const errs: string[] = [];
  const has = (v: number | null | undefined) => v !== null && v !== undefined;
  if (has(stop) && !(Number.isFinite(stop) && (stop as number) > 0)) errs.push('planned_stop_invalid');
  if (has(target) && !(Number.isFinite(target) && (target as number) > 0)) errs.push('planned_target_invalid');
  if (errs.length || !has(stop) || !has(target)) return errs;
  if (side === 'buy' && (stop as number) >= (target as number)) errs.push('planned_stop_must_be_below_target');
  if (side === 'sell_short' && (stop as number) <= (target as number)) errs.push('planned_stop_must_be_above_target');
  return errs;
}
