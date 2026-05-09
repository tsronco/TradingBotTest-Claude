import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BotRulesSection from '../../src/components/rules/BotRulesSection';
import type { BotRulesPayload } from '../../src/lib/rules-types';

const mkPayload = (mode: 'conservative' | 'aggressive' | 'manual'): BotRulesPayload => ({
  mode,
  wheel: {
    symbols: ['TSLA'],
    otm_pct: mode === 'aggressive' ? 0.05 : 0.10,
    dte_min: 14,
    dte_max: 28,
    close_at_profit_pct: 0.50,
  },
  strategy: {
    underlying: 'TSLA',
    initial_qty: 10,
    stop_loss_pct: 0.10,
    trail_activate_pct: 0.10,
    trail_floor_pct: 0.05,
    ladders: [{ trigger_pct: 0.15, qty: 8 }],
  },
  pushed_at: '2026-05-09T13:00:00Z',
});

describe('BotRulesSection', () => {
  it('renders all 3 mode columns even when some are null', () => {
    render(<BotRulesSection
      conservative={mkPayload('conservative')}
      aggressive={null}
      manual={null}
    />);
    expect(screen.getByText('Conservative')).toBeTruthy();
    expect(screen.getByText('Aggressive')).toBeTruthy();
    expect(screen.getByText('Manual')).toBeTruthy();
    // Two columns show "no data — bot hasn't pushed yet"
    expect(screen.getAllByText(/no data/i)).toHaveLength(2);
  });

  it('renders all 3 columns when all 3 are populated', () => {
    render(<BotRulesSection
      conservative={mkPayload('conservative')}
      aggressive={mkPayload('aggressive')}
      manual={mkPayload('manual')}
    />);
    // No "no data" placeholders
    expect(screen.queryByText(/no data/i)).toBeNull();
    // Each column shows the wheel symbols
    expect(screen.getAllByText(/TSLA/).length).toBeGreaterThanOrEqual(3);
  });

  it('shows manual flags when present', () => {
    const manual = { ...mkPayload('manual'), flags: { auto_discover_symbols: true, wheel_skip_new_puts: true } };
    render(<BotRulesSection
      conservative={null}
      aggressive={null}
      manual={manual}
    />);
    expect(screen.getByText(/auto_discover_symbols/)).toBeTruthy();
    expect(screen.getByText(/wheel_skip_new_puts/)).toBeTruthy();
  });
});
