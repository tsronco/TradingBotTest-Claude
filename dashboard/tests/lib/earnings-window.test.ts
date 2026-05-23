import { describe, expect, it } from 'vitest';
import { earningsInWindow } from '../../api/_lib/fundamentals-fetch';

describe('earningsInWindow', () => {
  it('true when an earnings date lands inside the hold window', () => {
    const dates = [{ date: '2026-05-10T20:00:00Z' }];
    expect(earningsInWindow(dates, '2026-05-01T14:00:00Z', '2026-05-15T20:00:00Z')).toBe(true);
  });

  it('true when the earnings date equals the window boundary', () => {
    const dates = [{ date: '2026-05-01T14:00:00Z' }];
    expect(earningsInWindow(dates, '2026-05-01T14:00:00Z', '2026-05-15T20:00:00Z')).toBe(true);
  });

  it('false when no earnings date falls in the window', () => {
    const dates = [{ date: '2026-04-01T20:00:00Z' }, { date: '2026-07-01T20:00:00Z' }];
    expect(earningsInWindow(dates, '2026-05-01T14:00:00Z', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('false on empty dates list', () => {
    expect(earningsInWindow([], '2026-05-01T14:00:00Z', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('false when from/to are unparseable', () => {
    const dates = [{ date: '2026-05-10T20:00:00Z' }];
    expect(earningsInWindow(dates, 'not-a-date', '2026-05-15T20:00:00Z')).toBe(false);
  });

  it('ignores entries with unparseable date strings', () => {
    const dates = [{ date: 'bogus' }, { date: '2026-05-10T20:00:00Z' }];
    expect(earningsInWindow(dates, '2026-05-01T14:00:00Z', '2026-05-15T20:00:00Z')).toBe(true);
  });
});
