// dashboard/api/_lib/proposal-prompts.ts
//
// Sonnet 4.6 wrappers that turn structured Findings into journal-quality
// rule proposals (and demote-rule suggestions). Uses prompt caching on
// the system block so the per-call cost is dominated by the small
// finding-specific user payload.

import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from './tendency-matchers.js';
import type { Proposal, ManualRule } from './rules-types.js';
import { newId } from './rules-types.js';

const MODEL = 'claude-sonnet-4-6';

const CACHED_SYSTEM = `You help a trader convert detected behavioral patterns into concise, journal-quality trading rules.

Severity levels:
- "block" — order placement requires typed override reasoning. Use ONLY when the pattern is severe (≥60% loss rate over ≥3 trades, or strong directional signal).
- "warn" — banner shown at order placement, click-through. Use as the default unless the evidence is overwhelming.

Trigger DSL (each rule has a list of triggers; ALL must match for the rule to fire):
- {"type":"symbol_in","symbols":["TSLA","F"]}
- {"type":"symbol_not_in","symbols":[...]}
- {"type":"side","value":"buy"|"sell"}
- {"type":"asset_class","value":"stock"|"option"}
- {"type":"option_type","value":"put"|"call"}
- {"type":"option_dte_lt","value":<number>}
- {"type":"option_dte_gt","value":<number>}
- {"type":"open_position_count_gt","value":<number>}
- {"type":"earnings_within_days","value":<number>}
- {"type":"strike_below_cost_basis"}
- {"type":"tag_present","tag":"<tag>"}

Output a single JSON object with these fields:
- proposed_rule_title (≤60 chars, plain English, trader's voice)
- proposed_rule_body (≤200 words, journal voice — "I" or imperative; no "the user" or "the trader")
- suggested_severity ("block" or "warn")
- suggested_triggers (array of valid triggers from the DSL above; you MAY adjust the suggestion)
- reasoning (≤80 words, references the evidence: "you did X N times, lost Y")

Style:
- Plain English. No jargon the trader hasn't already used.
- The body should sound like the trader wrote it for himself — second-person or imperative.
- If the finding doesn't justify a rule, return {"reasoning":"insufficient signal"} and skip the other fields.

Output ONLY the JSON object. No prose, no markdown fences.`;

interface EvidenceSnippet {
  id: string;
  symbol: string;
  pnl: number;
  closed_at: string;
}

export async function proposeNewRule(
  finding: Finding,
  evidenceSnippets: EvidenceSnippet[],
): Promise<Pick<Proposal, 'id' | 'matcher' | 'proposed_rule' | 'reasoning' | 'evidence_trade_ids' | 'status' | 'proposed_at'>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });

  const userBlock = JSON.stringify({
    matcher: finding.matcher,
    finding: finding.finding,
    suggested_severity: finding.suggested_severity,
    suggested_triggers: finding.suggested_triggers,
    evidence: evidenceSnippets.slice(0, 5),
  });

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: [
      { type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } },
    ] as any,
    messages: [{ role: 'user', content: userBlock }],
  });

  const text = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = /\{[\s\S]*\}/.exec(text);
    parsed = match ? JSON.parse(match[0]) : null;
  }
  if (!parsed || typeof parsed.proposed_rule_title !== 'string') {
    throw new Error('proposal generation returned unparseable output');
  }

  return {
    id: newId('p'),
    matcher: finding.matcher,
    proposed_rule: {
      title: String(parsed.proposed_rule_title).slice(0, 200),
      body: String(parsed.proposed_rule_body ?? '').slice(0, 2000),
      severity: parsed.suggested_severity === 'block' ? 'block' : 'warn',
      triggers: Array.isArray(parsed.suggested_triggers)
        ? parsed.suggested_triggers
        : finding.suggested_triggers,
    },
    reasoning: String(parsed.reasoning ?? finding.finding).slice(0, 1000),
    evidence_trade_ids: finding.evidence_trade_ids,
    status: 'open',
    proposed_at: new Date().toISOString(),
  };
}

/**
 * Build a demote proposal for an existing block-severity rule that the trader
 * has been overriding profitably. No LLM call — the proposal text is templated
 * since it's mechanical (rule was X, you overrode it N times, M% made money).
 */
export function proposeDemote(
  rule: ManualRule,
  stats: { overrides: number; profitable_pct: number },
): Pick<Proposal, 'id' | 'matcher' | 'proposed_rule' | 'reasoning' | 'evidence_trade_ids' | 'status' | 'proposed_at' | 'demote_target_rule_id'> {
  return {
    id: newId('p'),
    matcher: 'override_loss_pattern',
    proposed_rule: {
      title: `Demote: ${rule.title}`,
      body: `${rule.body}\n\n(suggested demote: you've overridden this ${stats.overrides} times and ${(stats.profitable_pct * 100).toFixed(0)}% of overrides were profitable — consider downgrading to warn.)`,
      severity: 'warn',
      triggers: rule.triggers,
    },
    reasoning: `You overrode "${rule.title}" ${stats.overrides} times this period and ${(stats.profitable_pct * 100).toFixed(0)}% of those overrides made money — the rule may be too strict.`,
    evidence_trade_ids: [],
    status: 'open',
    proposed_at: new Date().toISOString(),
    demote_target_rule_id: rule.id,
  };
}
