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
import { rulesKey, botRulesKey } from '../_lib/kv-keys.js';
import { isTrigger, newId, type ManualRule, type Pattern, type Cheatsheet, type Goal, type Tendency, type Proposal } from '../_lib/rules-types.js';

interface BaseRecord {
  id: string;
  created_at: string;
  updated_at: string;
}

async function genericCrud<T extends BaseRecord>(
  req: VercelRequest,
  res: VercelResponse,
  key: string,
  validate: (body: unknown) => string | null,
  idPrefix: string,
) {
  const list = (await kv().get<T[]>(key)) ?? [];

  if (req.method === 'GET') {
    return res.status(200).json({ items: list });
  }

  if (req.method === 'POST') {
    const err = validate(req.body);
    if (err) return res.status(400).json({ error: err });
    const now = new Date().toISOString();
    const record = {
      ...(req.body as object),
      id: newId(idPrefix),
      created_at: now,
      updated_at: now,
    } as T;
    await kv().set(key, [...list, record]);
    return res.status(201).json({ item: record });
  }

  if (req.method === 'PATCH') {
    const { id, patch } = (req.body ?? {}) as { id?: string; patch?: Record<string, unknown> };
    if (typeof id !== 'string' || !patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'id_and_patch_required' });
    }
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not_found' });

    const merged = { ...list[idx], ...patch };
    const err = validate(merged);
    if (err) return res.status(400).json({ error: err });

    const updated = {
      ...merged,
      id: list[idx].id,
      created_at: list[idx].created_at,
      updated_at: new Date().toISOString(),
    } as T;
    const next = list.map((r, i) => (i === idx ? updated : r));
    await kv().set(key, next);
    return res.status(200).json({ item: updated });
  }

  if (req.method === 'DELETE') {
    const { id } = (req.body ?? {}) as { id?: string };
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'id_required' });
    }
    const next = list.filter((r) => r.id !== id);
    await kv().set(key, next);
    return res.status(200).json({ ok: true, removed: id });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}

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

async function patternsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Pattern>(req, res, rulesKey('patterns'), (b) => {
    const obj = b as Record<string, unknown> | null;
    if (!obj || typeof obj.name !== 'string' || !obj.name) return 'name_required';
    if (typeof obj.environment !== 'string') return 'environment_required';
    if (!Array.isArray(obj.variables)) return 'variables_must_be_array';
    if (!Array.isArray(obj.legs)) return 'legs_must_be_array';
    if (!Array.isArray(obj.rules)) return 'rules_must_be_array';
    if (obj.win_rate !== undefined && typeof obj.win_rate !== 'number') return 'win_rate_must_be_number';
    return null;
  }, 'p');
}

async function cheatsheetsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Cheatsheet>(req, res, rulesKey('cheatsheets'), (b) => {
    const obj = b as Record<string, unknown> | null;
    if (!obj || typeof obj.title !== 'string' || !obj.title) return 'title_required';
    if (typeof obj.body !== 'string') return 'body_required';
    return null;
  }, 'c');
}

async function goalsHandler(req: VercelRequest, res: VercelResponse) {
  return genericCrud<Goal>(req, res, rulesKey('goals'), (b) => {
    const obj = b as Record<string, unknown> | null;
    if (!obj || typeof obj.body !== 'string' || !obj.body) return 'body_required';
    if (obj.target !== undefined && typeof obj.target !== 'string') return 'target_must_be_string';
    if (obj.due !== undefined && typeof obj.due !== 'string') return 'due_must_be_string';
    if (obj.checked !== undefined && typeof obj.checked !== 'boolean') return 'checked_must_be_boolean';
    return null;
  }, 'g');
}
async function tendenciesHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const tendencies = (await kv().get<Tendency[]>(rulesKey('tendencies'))) ?? [];
  return res.status(200).json({ tendencies });
}

async function proposalsHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];
    const cutoff = Date.now() - 30 * 86400000;
    const visible = proposals.filter((p) => {
      if (p.status === 'open') return true;
      const ts = p.resolved_at ? Date.parse(p.resolved_at) : Date.parse(p.proposed_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    return res.status(200).json({ proposals: visible });
  }
  if (req.method === 'POST') {
    // approve / dismiss / edit-and-approve land in M2.5
    return res.status(501).json({ error: 'not_implemented' });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function botHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const [conservative, aggressive, manual] = await Promise.all([
    kv().get(botRulesKey('conservative')),
    kv().get(botRulesKey('aggressive')),
    kv().get(botRulesKey('manual')),
  ]);
  return res.status(200).json({ conservative, aggressive, manual });
}
