import { useState } from 'react';
import { ThresholdsTab } from '../components/settings/ThresholdsTab';
import { TagsTab } from '../components/settings/TagsTab';
import { RecoveryTab } from '../components/settings/RecoveryTab';

type Tab = 'thresholds' | 'tags' | 'recovery';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('thresholds');

  return (
    <div className="p-3 md:p-6 max-w-4xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span>
        <span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span>
        <span className="text-dim">$</span>{' '}
        <span className="text-fg">edit --tab={tab}</span>
      </div>
      <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi mt-2">Settings</h1>
      <div className="text-mid text-[12px]"><span className="text-dim">// preferences · thresholds · recovery</span></div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(['thresholds', 'tags', 'recovery'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`pbtn ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            [{t}{tab === t ? '*' : ''}]
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'thresholds' && <ThresholdsTab />}
        {tab === 'tags' && <TagsTab />}
        {tab === 'recovery' && <RecoveryTab />}
      </div>

      {/* footer ribbon */}
      <div className="footer-ribbon mt-6 flex items-center gap-3 text-[11px] text-dim">
        <span>━━━ ledger</span>
        <span className="flex-1 border-t border-border" />
        <span className="text-dim">— press</span>
        <span className="text-fg border border-border px-1.5 rounded-sm">?</span>
        <span className="text-dim">for keymap</span>
      </div>

      {/* bottom prompt */}
      <div className="mt-4 text-[12px]">
        <span className="text-mid">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
