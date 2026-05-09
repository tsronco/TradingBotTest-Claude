import { describe, it, expect } from 'vitest';
import { etDateAt, etOffsetMinutes, etTodayAt, isAfterEtNow, hoursUntilEt } from '../../api/_lib/et-time';

describe('et-time helpers', () => {
  describe('etOffsetMinutes', () => {
    it('returns -240 (EDT) during summer', () => {
      const summer = new Date('2026-06-15T16:00:00Z');
      expect(etOffsetMinutes(summer)).toBe(-240);
    });

    it('returns -300 (EST) during winter', () => {
      const winter = new Date('2026-01-15T16:00:00Z');
      expect(etOffsetMinutes(winter)).toBe(-300);
    });
  });

  describe('etDateAt', () => {
    it('produces correct UTC during EDT', () => {
      // 2026-06-15 16:00 ET (EDT, UTC-4) = 2026-06-15 20:00 UTC
      const d = etDateAt(2026, 6, 15, 16, 0);
      expect(d.toISOString()).toBe('2026-06-15T20:00:00.000Z');
    });

    it('produces correct UTC during EST', () => {
      // 2026-01-15 16:00 ET (EST, UTC-5) = 2026-01-15 21:00 UTC
      const d = etDateAt(2026, 1, 15, 16, 0);
      expect(d.toISOString()).toBe('2026-01-15T21:00:00.000Z');
    });

    it('handles March DST start (EST → EDT)', () => {
      // 2026-03-09 is the day after DST start in 2026 — full EDT in effect
      // 2026-03-09 16:00 ET (EDT) = 2026-03-09 20:00 UTC
      const d = etDateAt(2026, 3, 9, 16, 0);
      expect(d.toISOString()).toBe('2026-03-09T20:00:00.000Z');
    });

    it('handles November DST end (EDT → EST)', () => {
      // 2026-11-02 is the day after DST end — full EST in effect
      // 2026-11-02 16:00 ET (EST) = 2026-11-02 21:00 UTC
      const d = etDateAt(2026, 11, 2, 16, 0);
      expect(d.toISOString()).toBe('2026-11-02T21:00:00.000Z');
    });
  });

  describe('etTodayAt', () => {
    it('returns a Date at the requested ET hour today', () => {
      const d = etTodayAt(16, 0);
      expect(d).toBeInstanceOf(Date);
      // It should be in the same day or the next/previous depending on timezone
      // Just sanity check the seconds are 0
      expect(d.getUTCSeconds()).toBe(0);
    });
  });

  describe('isAfterEtNow', () => {
    it('returns true for a future date', () => {
      const future = new Date(Date.now() + 60_000);
      expect(isAfterEtNow(future)).toBe(true);
    });
    it('returns false for a past date', () => {
      const past = new Date(Date.now() - 60_000);
      expect(isAfterEtNow(past)).toBe(false);
    });
  });

  describe('hoursUntilEt', () => {
    it('returns positive hours for a future date', () => {
      const future = new Date(Date.now() + 2 * 3_600_000);
      expect(hoursUntilEt(future)).toBeCloseTo(2, 1);
    });
    it('returns negative hours for a past date', () => {
      const past = new Date(Date.now() - 2 * 3_600_000);
      expect(hoursUntilEt(past)).toBeCloseTo(-2, 1);
    });
  });
});
