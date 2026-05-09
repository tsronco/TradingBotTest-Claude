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
import { isTrigger, newId, type ManualRule } from '../_lib/rules-types.js';

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
  const list = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];

  if (req.method === 'GET') {
    return res.status(200).json({ rules: list });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Partial<ManualRule>;
    const { title, body: ruleBody, severity, triggers } = body;
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title_required' });
    }
    if (typeof ruleBody !== 'string') {
      return res.status(400).json({ error: 'body_required' });
    }
    if (severity !== 'block' && severity !== 'warn') {
      return res.status(400).json({ error: 'invalid_severity' });
    }
    if (!Array.isArray(triggers) || !triggers.every(isTrigger)) {
      return res.status(400).json({ error: 'invalid_triggers' });
    }
    const now = new Date().toISOString();
    const rule: ManualRule = {
      id: newId('r'),
      title: title.trim(),
      body: ruleBody,
      severity,
      triggers,
      source: 'manual',
      created_at: now,
      updated_at: now,
    };
    await kv().set(rulesKey('manual'), [...list, rule]);
    return res.status(201).json({ rule });
  }

  if (req.method === 'PATCH') {
    const { id, patch } = (req.body ?? {}) as { id?: string; patch?: Partial<ManualRule> };
    if (typeof id !== 'string' || !patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'id_and_patch_required' });
    }
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not_found' });

    if (patch.severity !== undefined && patch.severity !== 'block' && patch.severity !== 'warn') {
      return res.status(400).json({ error: 'invalid_severity' });
    }
    if (patch.triggers !== undefined) {
      if (!Array.isArray(patch.triggers) || !patch.triggers.every(isTrigger)) {
        return res.status(400).json({ error: 'invalid_triggers' });
      }
    }

    const updated: ManualRule = {
      ...list[idx],
      ...patch,
      id: list[idx].id,                   // never overwrite id
      source: list[idx].source,           // never overwrite source via patch
      created_at: list[idx].created_at,
      updated_at: new Date().toISOString(),
    };
    const next = list.map((r, i) => (i === idx ? updated : r));
    await kv().set(rulesKey('manual'), next);
    return res.status(200).json({ rule: updated });
  }

  if (req.method === 'DELETE') {
    const { id } = (req.body ?? {}) as { id?: string };
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'id_required' });
    }
    const next = list.filter((r) => r.id !== id);
    await kv().set(rulesKey('manual'), next);
    return res.status(200).json({ ok: true, removed: id });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
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
