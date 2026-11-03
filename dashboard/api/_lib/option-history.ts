// Was this account already LONG an option contract just before a given sale?
//
// Answers "is this option sell a sell-to-CLOSE?" from Alpaca's own FILL
// history, for fills that don't carry `position_effect` (the importer's only
// other signal). Without it the importer booked every option sell as a new
// short (STO) — so the agent's closing sale of its SLV long call on 2026-09-28
// became a phantom open "STO 1 SLV" record that could never close.
//
// Net position for the contract = Σ buy qty − Σ sell qty over fills strictly
// before the sale. If that is ≥ the sale qty, the sale closed a long.
import { alpacaTrade } from './data-api.js';
import type { Mode } from './alpaca.js';

interface Fill {
  id?: string;
  symbol?: string;
  side?: string;
  qty?: string;
  transaction_time?: string;
}

// How far back to look for the opening buy. Options rarely outlive this; the
// agent's longest holds are ~5 weeks.
const LOOKBACK_DAYS = 120;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * true  → the account held ≥ qty long of `occ` just before `beforeIso` (a close)
 * false → it did not (a genuine opening sale)
 * null  → couldn't tell (fetch failed / page cap) — caller keeps its default
 */
export async function heldLongBefore(
  mode: Mode,
  occ: string,
  beforeIso: string,
  qty: number,
): Promise<boolean | null> {
  const before = Date.parse(beforeIso);
  if (!Number.isFinite(before)) return null;
  const after = new Date(before - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  let net = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let fills: Fill[];
    try {
      const params: Record<string, string | number> = { activity_types: 'FILL', after, page_size: PAGE_SIZE };
      if (pageToken) params.page_token = pageToken;
      const raw = await alpacaTrade<Fill[]>(mode, '/v2/account/activities', params);
      fills = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.error('heldLongBefore activities fetch failed', occ, e);
      return null;
    }
    for (const f of fills) {
      if (f.symbol !== occ || !f.transaction_time) continue;
      if (Date.parse(f.transaction_time) >= before) continue;
      const q = Math.abs(Number(f.qty ?? 0));
      if (!Number.isFinite(q)) continue;
      const side = (f.side ?? '').toLowerCase();
      if (side === 'buy') net += q;
      else if (side === 'sell' || side === 'sell_short') net -= q;
    }
    if (fills.length < PAGE_SIZE) return net >= qty;
    const lastId = fills[fills.length - 1]?.id;
    if (!lastId) return net >= qty;
    pageToken = lastId;
  }
  return null; // page cap — don't guess
}
