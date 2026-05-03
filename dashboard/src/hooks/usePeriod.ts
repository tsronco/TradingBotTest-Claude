import { useEffect, useState } from 'react';

export type Period = '1D' | '1W' | '1M' | '3M' | '1A';
export type Granularity = '1m' | '5m' | '15m' | '1h';

const PERIOD_KEY = 'dash:selectedPeriod';
const GRAN_KEY = 'dash:selectedGranularity';
const PERIOD_EVENT = 'dash:period-change';
const GRAN_EVENT = 'dash:granularity-change';

const PERIODS: readonly Period[] = ['1D', '1W', '1M', '3M', '1A'] as const;
const GRANULARITIES: readonly Granularity[] = ['1m', '5m', '15m', '1h'] as const;

function readPeriod(): Period {
  if (typeof window === 'undefined') return '1M';
  const v = localStorage.getItem(PERIOD_KEY) as Period | null;
  return v && (PERIODS as readonly string[]).includes(v) ? v : '1M';
}

function readGranularity(): Granularity {
  if (typeof window === 'undefined') return '5m';
  const v = localStorage.getItem(GRAN_KEY) as Granularity | null;
  return v && (GRANULARITIES as readonly string[]).includes(v) ? v : '5m';
}

export function usePeriod(): [Period, (p: Period) => void] {
  const [period, setPeriod] = useState<Period>(readPeriod);
  useEffect(() => {
    const handler = () => setPeriod(readPeriod());
    window.addEventListener(PERIOD_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(PERIOD_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  const set = (p: Period) => {
    localStorage.setItem(PERIOD_KEY, p);
    setPeriod(p);
    window.dispatchEvent(new CustomEvent(PERIOD_EVENT));
  };
  return [period, set];
}

export function useGranularity(): [Granularity, (g: Granularity) => void] {
  const [gran, setGran] = useState<Granularity>(readGranularity);
  useEffect(() => {
    const handler = () => setGran(readGranularity());
    window.addEventListener(GRAN_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(GRAN_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  const set = (g: Granularity) => {
    localStorage.setItem(GRAN_KEY, g);
    setGran(g);
    window.dispatchEvent(new CustomEvent(GRAN_EVENT));
  };
  return [gran, set];
}

/** Map UI period → Alpaca portfolio-history period parameter. */
export function alpacaPeriod(p: Period): string {
  return p; // Alpaca accepts 1D/1W/1M/3M/1A as-is
}

/** Map UI period (and granularity for 1D) → Alpaca timeframe parameter. */
export function alpacaTimeframe(p: Period, g: Granularity): string {
  if (p === '1D') {
    return { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '1H' }[g];
  }
  if (p === '1W') return '1H';
  return '1D';
}
