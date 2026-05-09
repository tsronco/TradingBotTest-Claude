// dashboard/api/rules/[resource].ts
//
// Catchall for the Phase 3 rules API.
//   GET    manual / patterns / cheatsheets / goals / tendencies / proposals / bot
//   POST   manual / patterns / cheatsheets / goals / proposals (action: approve|dismiss|edit-and-approve)
//   PATCH  manual / patterns / cheatsheets / goals  (id + patch)
//   DELETE manual / patterns / cheatsheets / goals  (id)
//
// Auth: requireAuth (session cookie). All resources gated.
// This skeleton wires routing + auth + the manual GET path. Other resources
// return 501 here; they're filled in by subsequent tasks (M2.2-M2.5).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard.js';
import { kv } from '../_lib/kv.js';
import { rulesKey } from '../_lib/kv-keys.js';
import type { ManualRule } from '../_lib/rules-types.js';

type Resource =
  | 'manual'
  | 'patterns'
  | 'cheatsheets'
  | 'goals'
  | 'tendencies'
  | 'proposals'
  | 'bot';

const VALID: readonly Resource[] = [
  'manual', 'patterns', 'cheatsheets', 'goals', 'tendencies', 'proposals', 'bot',
] as const;

function isValidResource(r: string): r is Resource {
  return (VALID as readonly string[]).includes(r);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;

  const resource = String(req.query.resource ?? '');
  if (!isValidResource(resource)) {
    return res.status(404).json({ error: 'unknown_resource' });
  }

  switch (resource) {
    case 'manual':       return manualHandler(req, res);
    case 'patterns':     return patternsHandler(req, res);
    case 'cheatsheets':  return cheatsheetsHandler(req, res);
    case 'goals':        return goalsHandler(req, res);
    case 'tendencies':   return tendenciesHandler(req, res);
    case 'proposals':    return proposalsHandler(req, res);
    case 'bot':          return botHandler(req, res);
  }
}

async function manualHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const rules = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];
    return res.status(200).json({ rules });
  }
  return res.status(501).json({ error: 'not_implemented' });
}

async function patternsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function cheatsheetsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function goalsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function tendenciesHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function proposalsHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
async function botHandler(_req: VercelRequest, res: VercelResponse) {
  return res.status(501).json({ error: 'not_implemented' });
}
