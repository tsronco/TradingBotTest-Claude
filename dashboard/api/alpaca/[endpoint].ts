import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { modeFromQuery, liveGuard } from '../_lib/alpaca.js';
import { alpacaData, alpacaTrade, alpacaTradeMutation } from '../_lib/data-api.js';
import { getOrCreateSummary } from '../_lib/ai-summary.js';
import { kv } from '../_lib/kv.js';
import { KV_KEYS, tradeKey } from '../_lib/kv-keys.js';
import {
  pairOrders,
  type PairableOrder,
  type OptionActivityEvent,
} from '../_lib/order-pairing.js';

// Subset of the Alpaca Order shape we touch in pairing + response. The SDK's
// own Order type is huge; we only need these fields and adding `realized_pl`
// + a possibly-overridden `status`.
type AlpacaOrder = {
  id: string;
  symbol: string;
  side: string;
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
};

type OptionContract = {
  symbol: string;
  expiration_date: string;
  strike_price: string;
  type: 'call' | 'put';
  // Returned by /v2/options/contracts but missing from /v1beta1/options/snapshots,
  // so we thread it through manually below.
  open_interest?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isMutation = ['modify-order', 'cancel-order'].includes(String(req.query.endpoint ?? ''));
  if (req.method !== 'GET' && !isMutation) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const endpoint = String(req.query.endpoint ?? '');
  const mode = modeFromQuery(req.query.mode);

  try {
    if (endpoint === 'clock') {
      // NYSE clock — account-agnostic, so we just use whatever creds `mode`
      // resolves to (defaults to conservative paper). Alpaca's /clock natively
      // accounts for weekends, holidays, half-days, and ad-hoc closures, so the
      // dashboard header uses it as the authoritative open/closed source.
      const clock = await alpacaTrade<unknown>(mode, '/v2/clock');
      return res.status(200).json({ mode, clock });
    }
    if (endpoint === 'account') {
      const account = await alpacaTrade<unknown>(mode, '/v2/account');
      return res.status(200).json({ mode, account });
    }
    if (endpoint === 'positions') {
      const positions = await alpacaTrade<unknown>(mode, '/v2/positions');
      return res.status(200).json({ mode, positions });
    }
    if (endpoint === 'orders') {
      const statusRaw = (Array.isArray(req.query.status) ? req.query.status[0] : req.query.status) ?? 'all';
      const status = ['open', 'closed', 'all'].includes(statusRaw as string)
        ? (statusRaw as 'open' | 'closed' | 'all')
        : 'all';
      const afterRaw = Array.isArray(req.query.after) ? req.query.after[0] : req.query.after;
      const userAfter = afterRaw && !Number.isNaN(Date.parse(afterRaw)) ? afterRaw : undefined;

      // For pairing to be correct, we need enough history to find the OPENER
      // for any closing leg in the user's window. We always look back at least
      // 90 days for context, even if the user picked "today" — otherwise a
      // BTC today wouldn't pair with last week's STO. The user-window filter
      // is applied AFTER pairing, on the final response.
      const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
      const minPairingAfter = new Date(Date.now() - NINETY_DAYS_MS).toISOString();
      const fetchAfter =
        userAfter && Date.parse(userAfter) > Date.parse(minPairingAfter) ? minPairingAfter : userAfter;

      // Paginate orders. Alpaca returns up to 500 newest-first per page; we
      // walk back via the `until` param until empty or before the fetch window.
      const allOrders: AlpacaOrder[] = [];
      let until: string | undefined = undefined;
      const MAX_PAGES = 20; // 20 * 500 = 10k orders ceiling — plenty for a year.
      for (let page = 0; page < MAX_PAGES; page++) {
        const pageOrders = await alpacaTrade<AlpacaOrder[]>(mode, '/v2/orders', {
          status,
          limit: 500,
          direction: 'desc',
          ...(fetchAfter ? { after: fetchAfter } : {}),
          ...(until ? { until } : {}),
        });
        if (!Array.isArray(pageOrders) || pageOrders.length === 0) break;
        allOrders.push(...pageOrders);
        if (pageOrders.length < 500) break; // last page
        // Step `until` back to 1ms before the oldest order so we don't refetch it.
        const oldest = pageOrders[pageOrders.length - 1];
        until = new Date(Date.parse(oldest.submitted_at) - 1).toISOString();
      }

      // Activities for option assignments + expirations. These are the closing
      // legs for any STO that didn't get bought back. /v2/account/activities
      // accepts a comma-separated activity_types list and an `after` date
      // filter (YYYY-MM-DD only — no time component).
      let activities: OptionActivityEvent[] = [];
      if (status !== 'open') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = await alpacaTrade<any[]>(mode, '/v2/account/activities', {
            activity_types: 'OPEXP,OPASN',
            after: fetchAfter ? fetchAfter.slice(0, 10) : undefined,
            page_size: 100,
          });
          activities = (Array.isArray(raw) ? raw : []).flatMap((a): OptionActivityEvent[] => {
            const t = a?.activity_type === 'OPEXP' || a?.activity_type === 'OPASN' ? a.activity_type : null;
            if (!t || !a?.symbol || !a?.qty || !a?.id || !a?.date) return [];
            // Activities only carry a date. Anchor at 4:00 PM ET (≈ market close
            // = 20:00 UTC) so they sort after same-day fills in the pairing pass.
            return [{
              id: String(a.id),
              activity_type: t,
              symbol: String(a.symbol),
              qty: String(a.qty),
              occurred_at: `${a.date}T20:00:00.000Z`,
            }];
          });
        } catch {
          // Activities are nice-to-have for pairing. If the call fails, we
          // still return orders — closers paired by orders alone still work.
          activities = [];
        }
      }

      // Build the pairing input and run it. Only filled orders contribute.
      const filledForPairing: PairableOrder[] = allOrders
        .filter((o) => o.filled_at && o.filled_avg_price && Number(o.filled_qty) > 0)
        .filter((o) => o.side === 'buy' || o.side === 'sell' || o.side === 'sell_short')
        .map((o) => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side as PairableOrder['side'],
          filled_qty: o.filled_qty,
          filled_avg_price: o.filled_avg_price as string,
          filled_at: o.filled_at as string,
        }));
      const { realizedByOrderId, statusByOrderId } = pairOrders(filledForPairing, activities);

      // Apply the user's date window AFTER pairing — open orders have no
      // submitted_at filter (always show all open), closed orders honor it.
      const inUserWindow = (o: AlpacaOrder): boolean => {
        if (!userAfter) return true;
        if (status === 'open') return true;
        const ts = o.filled_at ?? o.submitted_at;
        return ts ? Date.parse(ts) >= Date.parse(userAfter) : true;
      };

      const enriched = allOrders.filter(inUserWindow).map((o) => {
        const realized_pl = realizedByOrderId.get(o.id);
        const statusOverride = statusByOrderId.get(o.id);
        return {
          ...o,
          realized_pl: realized_pl !== undefined ? realized_pl : null,
          // Override status when an activity closed the leg, so the UI can
          // distinguish an expired/assigned STO from one still open.
          status: statusOverride ?? o.status,
        };
      });

      return res.status(200).json({ mode, status, orders: enriched });
    }
    if (endpoint === 'quote') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const kind = String(req.query.kind ?? 'stock');

      if (kind === 'option') {
        if (!/^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(symbol)) {
          return res.status(400).json({ error: 'invalid_option_symbol' });
        }
        const snap = await alpacaData(mode, '/v1beta1/options/snapshots', { symbols: symbol });
        return res.status(200).json({ mode, symbol, snapshot: snap });
      }

      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const snap = await alpacaData(mode, '/v2/stocks/snapshots', { symbols: symbol });
      return res.status(200).json({ mode, symbol, snapshot: snap });
    }
    if (endpoint === 'chain') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const expiration = req.query.expiration ? String(req.query.expiration) : undefined;
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }

      // Bypass the SDK and paginate ourselves. Three reasons:
      //   1. SDK's `getOptionsContracts` returns `OptionsContract[]` directly — it
      //      strips `next_page_token` from the response, so callers can't paginate.
      //   2. Without an explicit limit, Alpaca returns ~100 contracts/page, which on
      //      a liquid underlying like TSLA is exactly one expiration. The dashboard
      //      needs all expirations to populate the dropdown.
      //   3. `status=active` alone returns ONLY ~3 nearest expirations on TSLA
      //      (~600 contracts). Adding `expiration_date_gte=today` widens the
      //      response to the full forward chain — 25+ expirations, weeklies +
      //      monthlies + LEAPS through 2028. Confirmed via direct curl 2026-05-02.
      // With limit=10000 even TSLA's full forward chain (~5700 contracts) fits in
      // a single page, but we still loop on next_page_token in case that changes.
      const today = new Date().toISOString().slice(0, 10);
      const allContracts: OptionContract[] = [];
      let pageToken: string | undefined = undefined;
      let pageCount = 0;
      const MAX_PAGES = 5; // safety cap — should never need this many

      do {
        const resp = await alpacaTrade<{
          option_contracts?: OptionContract[];
          next_page_token?: string;
        }>(mode, '/v2/options/contracts', {
          underlying_symbols: symbol,
          status: 'active',
          limit: 10000,
          expiration_date: expiration,
          expiration_date_gte: expiration ? undefined : today,
          page_token: pageToken,
        });
        if (Array.isArray(resp.option_contracts)) {
          allContracts.push(...resp.option_contracts);
        }
        pageToken = resp.next_page_token || undefined;
        pageCount++;
      } while (pageToken && pageCount < MAX_PAGES);

      if (allContracts.length === 0) {
        return res.status(200).json({ mode, symbol, expiration, contracts: [], snapshots: {} });
      }

      // Two-mode operation:
      //   - No `expiration` param: caller wants the dropdown of all expirations.
      //     Skip snapshots entirely (cheap fetch, big payload of contracts only).
      //   - With `expiration` param: caller picked an expiration and wants live
      //     quotes for it. The contracts query above already filtered to that
      //     expiration via `expiration_date`, so we snapshot all of them.
      //
      // Snapshots still get chunked at 100/request (Alpaca's hard cap; HTTP 400
      // "symbol limit is 100" above that). A single expiration on a liquid name
      // like INTC has 218 contracts → 3 chunks. Chunks run sequentially to keep
      // the request count bounded on the data-API rate limit. A single chunk
      // failing (transient 5xx) leaves other chunks' data intact rather than
      // blanking the whole chain.
      const snapshots: Record<string, Record<string, unknown>> = {};
      if (expiration) {
        const SNAPSHOT_CHUNK = 100;
        const targets = allContracts.map((c) => c.symbol);
        for (let i = 0; i < targets.length; i += SNAPSHOT_CHUNK) {
          const chunk = targets.slice(i, i + SNAPSHOT_CHUNK);
          try {
            const snapResp = await alpacaData<{ snapshots?: Record<string, Record<string, unknown>> }>(
              mode,
              '/v1beta1/options/snapshots',
              { symbols: chunk.join(',') }
            );
            Object.assign(snapshots, snapResp.snapshots ?? {});
          } catch (err) {
            console.error(`[chain] snapshot chunk ${i}-${i + chunk.length} failed for ${symbol} ${expiration}:`, err);
          }
        }
        // Merge open_interest from /v2/options/contracts into snapshots — Alpaca's
        // /v1beta1/options/snapshots doesn't include OI, but we already have the
        // contract metadata in hand, so this is free.
        for (const c of allContracts) {
          if (c.open_interest != null) {
            (snapshots[c.symbol] ??= {}).openInterest = Number(c.open_interest);
          }
        }
      }

      return res.status(200).json({
        mode, symbol, expiration,
        contracts: allContracts,
        snapshots,
      });
    }
    if (endpoint === 'news') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const newsResp = await alpacaData<{ news?: unknown[] }>(mode, '/v1beta1/news', { symbols: symbol, limit });
      return res.status(200).json({ symbol, news: newsResp.news ?? [] });
    }
    if (endpoint === 'equity-history') {
      // Default: last 30 calendar days at 1H granularity. Caller can override.
      const period = String(req.query.period ?? '1M');
      const timeframe = String(req.query.timeframe ?? '1H');
      const history = await alpacaTrade<{
        timestamp?: number[];
        equity?: number[];
        profit_loss?: number[];
        profit_loss_pct?: number[];
        base_value?: number;
      }>(mode, '/v2/account/portfolio/history', {
        period,
        timeframe,
        intraday_reporting: 'market_hours',
      });
      return res.status(200).json({ mode, period, timeframe, history });
    }
    if (endpoint === 'bars') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      const timeframe = String(req.query.timeframe ?? '1Day');
      const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 90));
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      // Alpaca returns bars:null when no start/end is given. Default to a window
      // ~2x the requested limit (calendar days) so we comfortably cover the bar count
      // even for daily timeframes that skip weekends.
      const startParam = req.query.start ? String(req.query.start) : undefined;
      const endParam = req.query.end ? String(req.query.end) : undefined;
      const start = startParam
        ?? new Date(Date.now() - limit * 2 * 86400000).toISOString().slice(0, 10);
      // Alpaca's single-symbol /bars response is { bars: [...], symbol, next_page_token }.
      // Unwrap so the client gets a flat array under `bars` instead of nested objects.
      const resp = await alpacaData<{ bars?: unknown[] }>(mode, `/v2/stocks/${symbol}/bars`, {
        timeframe, limit, start, end: endParam, feed: 'iex',
      });
      return res.status(200).json({ symbol, timeframe, bars: resp?.bars ?? [] });
    }
    if (endpoint === 'ai-summary') {
      const symbol = String(req.query.symbol ?? '').toUpperCase();
      if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
        return res.status(400).json({ error: 'invalid_symbol' });
      }
      const refresh = String(req.query.refresh ?? '') === '1';
      try {
        const result = await getOrCreateSummary(mode, symbol, { refresh });
        return res.status(200).json({ symbol, ...result });
      } catch (e) {
        return res.status(502).json({ error: 'ai_summary_failed', detail: String(e) });
      }
    }
    if (endpoint === 'modify-order' && req.method === 'POST') {
      // D1 — gate live money-moving writes behind LIVE_ENABLED.
      // GET reads are intentionally left ungated so live monitoring works.
      if (liveGuard(mode, res)) return;
      const body = (req.body ?? {}) as { order_id?: string; qty?: number; limit_price?: number; stop_price?: number; tif?: string };
      if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });
      const patch: Record<string, unknown> = {};
      if (body.qty != null) patch.qty = body.qty;
      if (body.limit_price != null) patch.limit_price = body.limit_price;
      if (body.stop_price != null) patch.stop_price = body.stop_price;
      if (body.tif) patch.time_in_force = body.tif;
      const updated = await alpacaTradeMutation<any>(mode, `/v2/orders/${body.order_id}`, { method: 'PATCH', body: patch });
      // Alpaca's modify creates a NEW order with a NEW id and marks the old
      // one `replaced`. Walk the open-trade index and update any trade that
      // pointed at the old id so the cron's syncFillData / detectClose can
      // find the live order. Without this, the trade record sits frozen
      // pointing at a "replaced" order forever.
      const newOrderId = updated?.id;
      if (newOrderId && newOrderId !== body.order_id) {
        const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
        for (const id of openIds) {
          const trade = await kv().get<any>(tradeKey(id));
          if (!trade || trade.alpaca_order_id !== body.order_id) continue;
          const modifyEvent = {
            ts: updated?.submitted_at ?? new Date().toISOString(),
            prev_order_id: body.order_id,
            new_order_id: newOrderId,
            qty: body.qty != null ? body.qty : (updated?.qty != null ? Number(updated.qty) : undefined),
            limit_price: body.limit_price != null ? body.limit_price : (updated?.limit_price != null ? Number(updated.limit_price) : undefined),
            stop_price: body.stop_price != null ? body.stop_price : (updated?.stop_price != null ? Number(updated.stop_price) : undefined),
            source: 'dashboard' as const,
          };
          await kv().set(tradeKey(id), {
            ...trade,
            alpaca_order_id: newOrderId,
            modify_history: [...(trade.modify_history ?? []), modifyEvent],
          });
          break;
        }
      }
      return res.status(200).json({ order: updated });
    }
    if (endpoint === 'cancel-order' && req.method === 'POST') {
      // D1 — gate live money-moving writes behind LIVE_ENABLED.
      // GET reads are intentionally left ungated so live monitoring works.
      if (liveGuard(mode, res)) return;
      const body = (req.body ?? {}) as { order_id?: string };
      if (!body.order_id) return res.status(400).json({ error: 'order_id_required' });

      // 1) Cancel on Alpaca
      await alpacaTradeMutation(mode, `/v2/orders/${body.order_id}`, { method: 'DELETE' });

      // 2) Find a matching trade record in trades:index:open and close it as 'canceled'
      // (only if it hasn't filled yet — filled trades use the normal close-order flow)
      const openIds = (await kv().lrange<string>(KV_KEYS.tradesIndexOpen, 0, -1)) ?? [];
      for (const id of openIds) {
        const trade = await kv().get<any>(tradeKey(id));
        if (!trade || trade.alpaca_order_id !== body.order_id) continue;
        if (trade.filled_at) continue; // already filled — let the normal close-order flow handle it
        const updated = {
          ...trade,
          closed_at: new Date().toISOString(),
          closed_avg_price: 0,
          realized_pnl: 0,
          closed_by: 'canceled',
        };
        await kv().set(tradeKey(id), updated);
        await kv().lrem(KV_KEYS.tradesIndexOpen, 0, id);
        break;
      }

      return res.status(200).json({ ok: true });
    }
    return res.status(404).json({ error: 'unknown_endpoint' });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
