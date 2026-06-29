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

async function ensureDefaultSpreadRiskRule(rules: ManualRule[]): Promise<ManualRule[]> {
  const hasRule = rules.some((r) =>
    r.triggers?.some((t) => t.type === 'max_risk_per_spread'),
  );
  if (hasRule) return rules;
  const now = new Date().toISOString();
  const seeded: ManualRule = {
    id: newId('r'),
    title: 'Max risk per spread',
    body: 'Cap defined risk per spread at $500. Warn when a trade exceeds this so I have to acknowledge it explicitly.',
    severity: 'warn',
    triggers: [{ type: 'max_risk_per_spread', max_dollars: 500 }],
    source: 'manual',
    created_at: now,
    updated_at: now,
  };
  const updated = [...rules, seeded];
  await kv().set(rulesKey('manual'), updated);
  return updated;
}

async function manualHandler(req: VercelRequest, res: VercelResponse) {
  const stored = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];

  if (req.method === 'GET') {
    const list = await ensureDefaultSpreadRiskRule(stored);
    return res.status(200).json({ rules: list });
  }

  const list = stored;

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
    const all = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];
    const cutoff = Date.now() - 30 * 86400000;
    const visible = all.filter((p) => {
      if (p.status === 'open') return true;
      const ts = p.resolved_at ? Date.parse(p.resolved_at) : Date.parse(p.proposed_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });
    return res.status(200).json({ proposals: visible });
  }

  if (req.method === 'POST') {
    const { action, proposal_id, edits } = (req.body ?? {}) as {
      action?: string;
      proposal_id?: string;
      edits?: Partial<Proposal['proposed_rule']>;
    };
    if (!['approve', 'dismiss', 'edit-and-approve'].includes(action ?? '')) {
      return res.status(400).json({ error: 'invalid_action' });
    }
    if (typeof proposal_id !== 'string') {
      return res.status(400).json({ error: 'proposal_id_required' });
    }

    const proposals = (await kv().get<Proposal[]>(rulesKey('proposals'))) ?? [];
    const idx = proposals.findIndex((p) => p.id === proposal_id);
    if (idx === -1) return res.status(404).json({ error: 'proposal_not_found' });

    const proposal = proposals[idx];
    if (proposal.status !== 'open') {
      return res.status(409).json({ error: 'proposal_already_resolved' });
    }
    if (action === 'edit-and-approve' && proposal.demote_target_rule_id) {
      return res.status(400).json({ error: 'cannot_edit_demote_proposal' });
    }

    const now = new Date().toISOString();

    if (action === 'dismiss') {
      const updated = { ...proposal, status: 'dismissed' as const, resolved_at: now };
      const next = proposals.map((p, i) => (i === idx ? updated : p));
      await kv().set(rulesKey('proposals'), next);
      return res.status(200).json({ proposal: updated });
    }

    // approve or edit-and-approve
    const finalRule = action === 'edit-and-approve' && edits
      ? { ...proposal.proposed_rule, ...edits }
      : proposal.proposed_rule;

    const manualList = (await kv().get<ManualRule[]>(rulesKey('manual'))) ?? [];

    if (proposal.demote_target_rule_id) {
      const targetIdx = manualList.findIndex((r) => r.id === proposal.demote_target_rule_id);
      if (targetIdx === -1) {
        return res.status(404).json({ error: 'demote_target_rule_not_found' });
      }
      const demoted: ManualRule = {
        ...manualList[targetIdx],
        severity: 'warn',
        updated_at: now,
      };
      const nextManual = manualList.map((r, i) => (i === targetIdx ? demoted : r));
      await kv().set(rulesKey('manual'), nextManual);
    } else {
      const newRule: ManualRule = {
        id: newId('r'),
        title: finalRule.title,
        body: finalRule.body,
        severity: finalRule.severity === 'block' ? 'block' : 'warn',
        triggers: finalRule.triggers,
        source: 'tendency',
        created_at: now,
        updated_at: now,
      };
      await kv().set(rulesKey('manual'), [...manualList, newRule]);
    }

    const updated = { ...proposal, status: 'approved' as const, resolved_at: now };
    const nextProposals = proposals.map((p, i) => (i === idx ? updated : p));
    await kv().set(rulesKey('proposals'), nextProposals);

    return res.status(200).json({ proposal: updated });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function botHandler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const [manual, live] = await Promise.all([
    kv().get(botRulesKey('manual')),
    kv().get(botRulesKey('live')),
  ]);
  return res.status(200).json({ manual, live });
}
