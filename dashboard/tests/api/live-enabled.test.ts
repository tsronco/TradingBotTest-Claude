import { describe, it, expect, afterEach } from 'vitest';
import { liveTradingEnabled } from '../../api/_lib/live-enabled';

// Live (real-money) dashboard trading is ON by default since 2026-09-08.
// LIVE_ENABLED=false is the only thing that turns it off.
describe('liveTradingEnabled', () => {
  const orig = process.env.LIVE_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.LIVE_ENABLED;
    else process.env.LIVE_ENABLED = orig;
  });

  it('is enabled when LIVE_ENABLED is unset (default on)', () => {
    delete process.env.LIVE_ENABLED;
    expect(liveTradingEnabled()).toBe(true);
  });

  it('is enabled when LIVE_ENABLED=true', () => {
    process.env.LIVE_ENABLED = 'true';
    expect(liveTradingEnabled()).toBe(true);
  });

  it('is disabled only by the exact kill-switch value LIVE_ENABLED=false', () => {
    process.env.LIVE_ENABLED = 'false';
    expect(liveTradingEnabled()).toBe(false);
  });

  it('treats other values as enabled (the switch is a kill switch, not an opt-in)', () => {
    process.env.LIVE_ENABLED = '0';
    expect(liveTradingEnabled()).toBe(true);
    process.env.LIVE_ENABLED = '';
    expect(liveTradingEnabled()).toBe(true);
  });
});
