import { useState } from 'react';
import { ThresholdsTab } from '../components/settings/ThresholdsTab';
import { TagsTab } from '../components/settings/TagsTab';
import { RecoveryTab } from '../components/settings/RecoveryTab';

type Tab = 'thresholds' | 'tags' | 'recovery';

export default function Settings() {
  const [tab, setTab] = useState<Tab>('thresholds');

  return (
    <div className="p-6 max-w-4xl">
      <div className="text-mid text-[12px]">
        <span className="text-cyan">tim@dash</span>
        <span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/settings</span>
        <span className="text-dim">$</span>{' '}
        <span className="text-fg">edit --tab={tab}</span>
      </div>
      <h1 className="text-[44px] font-bold tracking-tight text-hi mt-2">Settings</h1>
      <div className="text-mid text-[12px]"><span className="text-dim">// preferences · thresholds · recovery</span></div>

      <div className="mt-4 flex gap-2">
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
    </div>
  );
}
