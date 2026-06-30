import { useState, useEffect } from 'react';
import BotRulesSection from '../components/rules/BotRulesSection';
import ManualRulesSection from '../components/rules/ManualRulesSection';
import PatternsSection from '../components/rules/PatternsSection';
import TendenciesSection from '../components/rules/TendenciesSection';
import ProposalsSection from '../components/rules/ProposalsSection';
import CheatsheetsSection from '../components/rules/CheatsheetsSection';
import GoalsSection from '../components/rules/GoalsSection';
import { useBotRules, useProposals } from '../hooks/useRules';
import { useDisplayName } from '../hooks/useDisplayName';

const SECTIONS = [
  { key: 'bot',         title: 'Bot rules',         defaultOpen: true  },
  { key: 'manual',      title: 'My rules',          defaultOpen: true  },
  { key: 'patterns',    title: 'Playbook patterns', defaultOpen: false },
  { key: 'tendencies',  title: 'Tendencies',        defaultOpen: false },
  { key: 'proposals',   title: 'Proposals',         defaultOpen: true  },
  { key: 'cheatsheets', title: 'Cheatsheets',       defaultOpen: false },
  { key: 'goals',       title: 'Goals',             defaultOpen: false },
] as const;

const STORAGE_KEY = 'rules:expanded';

export default function Rules() {
  const { handle } = useDisplayName();
  const { data: bot } = useBotRules();
  const { data: proposalData } = useProposals();
  const openProposalCount = (proposalData?.proposals ?? []).filter((p) => p.status === 'open').length;

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {}
    return Object.fromEntries(SECTIONS.map((s) => [s.key, s.defaultOpen]));
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
  }, [expanded]);

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  function renderSection(key: string) {
    switch (key) {
      case 'bot':         return <BotRulesSection manual={bot?.manual ?? null} live={bot?.live ?? null} />;
      case 'manual':      return <ManualRulesSection />;
      case 'patterns':    return <PatternsSection />;
      case 'tendencies':  return <TendenciesSection />;
      case 'proposals':   return <ProposalsSection />;
      case 'cheatsheets': return <CheatsheetsSection />;
      case 'goals':       return <GoalsSection />;
    }
  }

  return (
    <div className="p-3 md:p-6 max-w-5xl">
      <div className="text-mid text-[12px] mb-4">
        <span className="text-cyan">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/rules</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">cat playbook</span>
      </div>
      <div className="space-y-3">
        {SECTIONS.map((s) => {
          const isOpen = expanded[s.key];
          const badge = s.key === 'proposals' && openProposalCount > 0
            ? <span className="ml-2 text-[10px] text-cyan tnum">({openProposalCount} open)</span>
            : null;
          return (
            <section key={s.key} className="border border-border bg-panel/30 rounded-sm">
              <button
                type="button"
                onClick={() => toggle(s.key)}
                className="w-full flex justify-between items-center p-3 hover:bg-panel-2/30 transition-colors"
                aria-expanded={isOpen}
              >
                <h2 className="text-fg font-semibold text-[13px] tracking-wider">
                  {s.title}{badge}
                </h2>
                <span className="text-mid text-[12px]">{isOpen ? '−' : '+'}</span>
              </button>
              {isOpen && (
                <div className="p-4 border-t border-border">
                  {renderSection(s.key)}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
