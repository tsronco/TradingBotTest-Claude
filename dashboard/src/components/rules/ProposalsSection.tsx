import { Link, useNavigate } from 'react-router-dom';
import { useProposals, useApproveProposal, useDismissProposal } from '../../hooks/useRules';
import type { Proposal } from '../../lib/rules-types';

export default function ProposalsSection() {
  const { data, isLoading } = useProposals();
  const approve = useApproveProposal();
  const dismiss = useDismissProposal();
  const nav = useNavigate();

  if (isLoading) return <div className="text-dim text-[11px]">loading…</div>;
  const open = (data?.proposals ?? []).filter((p: Proposal) => p.status === 'open');
  if (open.length === 0) return <div className="text-dim text-[11px]">no open proposals</div>;

  function handleDismiss(id: string) {
    if (!confirm("Dismiss this proposal? It won't be re-suggested.")) return;
    dismiss.mutate(id);
  }

  return (
    <ul className="space-y-3">
      {open.map((p: Proposal) => (
        <li key={p.id} className="border border-cyan/40 bg-cyan/5 p-3 space-y-2 rounded-sm text-[11px]">
          <div className="text-cyan text-[9px] uppercase tracking-[0.2em]">
            {p.demote_target_rule_id ? 'DEMOTE' : 'NEW RULE'} · {p.matcher}
          </div>
          <div className="text-fg font-medium">{p.proposed_rule.title}</div>
          <div className="text-fg/85 whitespace-pre-wrap">{p.proposed_rule.body}</div>
          <div className="text-[10px] text-mid italic">{p.reasoning}</div>
          {p.evidence_trade_ids.length > 0 && (
            <details>
              <summary className="text-[10px] text-mid cursor-pointer">
                {p.evidence_trade_ids.length} evidence trade{p.evidence_trade_ids.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-1 ml-3 space-y-0.5 text-[10px]">
                {p.evidence_trade_ids.map((id) => (
                  <li key={id}>· <Link to={`/trade/${id}`} className="text-cyan hover:underline">{id}</Link></li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2 pt-1 text-[10px]">
            <button
              onClick={() => approve.mutate(p.id)}
              disabled={approve.isPending}
              className="pbtn active border border-hi/60 text-hi"
            >
              [add to my rules]
            </button>
            <button
              onClick={() => nav(`/rules/edit?section=proposals&id=${p.id}`)}
              className="pbtn border border-cyan/60 text-cyan"
            >
              [edit then add]
            </button>
            <button
              onClick={() => handleDismiss(p.id)}
              disabled={dismiss.isPending}
              className="pbtn"
            >
              [dismiss]
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
