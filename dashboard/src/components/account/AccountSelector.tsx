import { useAccount, type AccountMode } from '../../hooks/useAccount';

const opts: { value: AccountMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'conservative', label: 'Conservative' },
  { value: 'aggressive', label: 'Aggressive' },
];

export default function AccountSelector() {
  const [mode, setMode] = useAccount();
  return (
    <div className="inline-flex bg-panel border border-border rounded-md overflow-hidden text-xs">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => setMode(o.value)}
          className={`px-3 py-1.5 ${
            mode === o.value
              ? 'bg-panel-2 text-text-strong'
              : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
