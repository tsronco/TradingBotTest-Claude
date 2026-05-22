import { useState } from 'react';
import { ThresholdsTab } from '../components/settings/ThresholdsTab';
import { TagsTab } from '../components/settings/TagsTab';
import { RecoveryTab } from '../components/settings/RecoveryTab';
import { ProfileTab } from '../components/settings/ProfileTab';
import { ImportTab } from '../components/settings/ImportTab';
import { useDisplayName } from '../hooks/useDisplayName';

type Tab = 'profile' | 'thresholds' | 'tags' | 'recovery';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('profile');
  const { handle } = useDisplayName();

  return (
    <div className="p-3 md:p-6 max-w-4xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">{handle}@dash</span>
        <span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span>
        <span className="text-dim">$</span>{' '}
        <span className="text-fg">edit --tab={tab}</span>
      </div>
      <h1 className="text-[28px] md:text-[44px] font-bold tracking-tight text-hi mt-2">Settings</h1>
      <div className="text-mid text-[12px]"><span className="text-dim">// profile · thresholds · tags · recovery</span></div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(['profile', 'thresholds', 'tags', 'recovery'] as Tab[]).map((t) => (
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
        {tab === 'profile' && <ProfileTab />}
        {tab === 'thresholds' && <ThresholdsTab />}
        {tab === 'tags' && <TagsTab />}
        {tab === 'recovery' && <RecoveryTab />}
      </div>

      {/* import from alpaca — deliberately understated, bottom-of-page one-shot */}
      <div className="mt-10">
        <div className="text-dim text-[10px] tracking-[0.3em] mb-3">// ADVANCED — ONE-SHOT</div>
        <ImportTab />
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
        <span className="text-mid">{handle}@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span><span className="text-dim">$</span>{' '}
        <span className="caret" />
      </div>
    </div>
  );
}
