import { describe, it, expect } from 'vitest';
import {
  nyseHolidays,
  nyseHalfDays,
  localMarketStatus,
  computeMarketStatus,
} from '../../src/lib/market-status';

describe('market-status', () => {
  describe('nyseHolidays', () => {
    it('includes the fixed + floating 2026 holidays with observed shifts', () => {
      const h = nyseHolidays(2026);
      expect(h.get('2026-01-01')).toBe("New Year's Day"); // Thu
      expect(h.get('2026-01-19')).toBe('Martin Luther King Jr. Day'); // 3rd Mon Jan
      expect(h.get('2026-02-16')).toBe("Presidents' Day"); // 3rd Mon Feb
      expect(h.get('2026-05-25')).toBe('Memorial Day'); // last Mon May
      expect(h.get('2026-06-19')).toBe('Juneteenth'); // Fri
      // July 4 2026 is a Saturday → observed the preceding Friday, July 3.
      expect(h.get('2026-07-03')).toBe('Independence Day');
      expect(h.get('2026-09-07')).toBe('Labor Day'); // 1st Mon Sep
      expect(h.get('2026-11-26')).toBe('Thanksgiving'); // 4th Thu Nov
      expect(h.get('2026-12-25')).toBe('Christmas'); // Fri
      // Good Friday is present (Apr 3 2026).
      expect([...h.values()]).toContain('Good Friday');
    });

    it('only shifts New Years forward (Sun→Mon), never back (Sat is not observed)', () => {
      // Jan 1 2022 is a Saturday — NYSE does NOT close Dec 31, no observance.
      const h22 = nyseHolidays(2022);
      expect(h22.has('2022-01-01')).toBe(false);
      expect(h22.has('2021-12-31')).toBe(false);
      // Jan 1 2023 is a Sunday — observed Monday Jan 2.
      const h23 = nyseHolidays(2023);
      expect(h23.get('2023-01-02')).toBe("New Year's Day");
      expect(h23.has('2023-01-01')).toBe(false);
    });

    it('omits Juneteenth before 2022', () => {
      expect([...nyseHolidays(2021).values()]).not.toContain('Juneteenth');
    });
  });

  describe('nyseHalfDays', () => {
    it('marks the 1 PM early-close days for 2025', () => {
      const hd = nyseHalfDays(2025);
      expect(hd.get('2025-07-03')).toBe('Independence Day eve'); // Thu, July 4 is Fri
      expect(hd.get('2025-11-28')).toBe('Day after Thanksgiving'); // Fri
      expect(hd.get('2025-12-24')).toBe('Christmas Eve'); // Wed
    });

    it('does not mark a half-day when that date is itself a full holiday', () => {
      // July 3 2026 is the observed Independence Day (full closure), so it must
      // NOT appear in the half-day set.
      expect(nyseHalfDays(2026).has('2026-07-03')).toBe(false);
    });
  });

  describe('localMarketStatus', () => {
    // Helper: all instants are explicit UTC so the test is timezone-independent.
    const at = (iso: string) => localMarketStatus(new Date(iso));

    it('closed on weekends', () => {
      const s = at('2026-06-20T16:00:00Z'); // Saturday
      expect(s.isOpen).toBe(false);
      expect(s.reason).toBe('Weekend');
      expect(s.label).toBe('CLOSED');
    });

    it('open during the regular session', () => {
      const s = at('2026-06-22T14:00:00Z'); // Mon 10:00 ET (EDT)
      expect(s.isOpen).toBe(true);
      expect(s.label).toBe('OPEN');
      expect(s.reason).toBe('Regular session');
      expect(s.etDateLabel).toBe('Mon Jun 22');
      expect(s.etDayLabel).toBe('Monday');
    });

    it('closed pre-market', () => {
      const s = at('2026-06-22T13:00:00Z'); // Mon 09:00 ET
      expect(s.isOpen).toBe(false);
      expect(s.reason).toContain('Pre-market');
    });

    it('closed after hours', () => {
      const s = at('2026-06-22T20:30:00Z'); // Mon 16:30 ET
      expect(s.isOpen).toBe(false);
      expect(s.reason).toContain('After hours');
      expect(s.reason).toContain('4:00 PM ET');
    });

    it('closed on a holiday with the holiday name as the reason', () => {
      const s = at('2026-06-19T14:00:00Z'); // Juneteenth, Fri 10:00 ET
      expect(s.isOpen).toBe(false);
      expect(s.reason).toBe('Juneteenth');
    });

    it('open on a half-day shows the ½-day marker', () => {
      const s = at('2025-11-28T17:00:00Z'); // Day after Thanksgiving, 12:00 ET (EST)
      expect(s.isOpen).toBe(true);
      expect(s.isHalfDay).toBe(true);
      expect(s.label).toBe('OPEN · ½ day');
      expect(s.reason).toContain('1:00 PM ET');
    });

    it('closed after the 1 PM half-day close', () => {
      const s = at('2025-11-28T18:30:00Z'); // 13:30 ET
      expect(s.isOpen).toBe(false);
      expect(s.isHalfDay).toBe(true);
      expect(s.reason).toContain('1:00 PM ET');
    });

    it('open exactly at 9:30 ET, closed at 9:29', () => {
      expect(at('2026-06-22T13:30:00Z').isOpen).toBe(true); // 09:30
      expect(at('2026-06-22T13:29:00Z').isOpen).toBe(false); // 09:29
    });

    it('closed exactly at 16:00 ET, open at 15:59', () => {
      expect(at('2026-06-22T20:00:00Z').isOpen).toBe(false); // 16:00
      expect(at('2026-06-22T19:59:00Z').isOpen).toBe(true); // 15:59
    });
  });

  describe('computeMarketStatus (Alpaca clock override)', () => {
    const weekend = new Date('2026-06-20T16:00:00Z');
    const regularOpen = new Date('2026-06-22T14:00:00Z');

    it('falls back to the local calendar when no clock is provided', () => {
      expect(computeMarketStatus(weekend).reason).toBe('Weekend');
      expect(computeMarketStatus(weekend, null).isOpen).toBe(false);
    });

    it('clock open overrides local closed', () => {
      const s = computeMarketStatus(weekend, { is_open: true });
      expect(s.isOpen).toBe(true);
      expect(s.label).toBe('OPEN');
    });

    it('clock closed overrides local open (ad-hoc closure)', () => {
      const s = computeMarketStatus(regularOpen, { is_open: false });
      expect(s.isOpen).toBe(false);
      expect(s.label).toBe('CLOSED');
      expect(s.reason).toBe('Market closed');
    });

    it('clock closed keeps the local reason when local already explains it', () => {
      const s = computeMarketStatus(weekend, { is_open: false });
      expect(s.isOpen).toBe(false);
      expect(s.reason).toBe('Weekend');
    });

    it('detects a half-day from the clock next_close at 1 PM ET', () => {
      const s = computeMarketStatus(regularOpen, {
        is_open: true,
        next_close: '2026-06-22T17:00:00Z', // 13:00 ET (EDT)
      });
      expect(s.isHalfDay).toBe(true);
      expect(s.label).toBe('OPEN · ½ day');
    });

    it('a normal 4 PM close is not flagged as a half-day', () => {
      const s = computeMarketStatus(regularOpen, {
        is_open: true,
        next_close: '2026-06-22T20:00:00Z', // 16:00 ET
      });
      expect(s.isHalfDay).toBe(false);
      expect(s.label).toBe('OPEN');
    });
  });
});
