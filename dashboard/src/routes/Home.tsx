import AccountCard from '../components/account/AccountCard';

export default function Home() {
  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Today</h1>
        <span className="text-muted text-xs">
          {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AccountCard mode="conservative" label="Conservative" />
        <AccountCard mode="aggressive" label="Aggressive" />
      </div>
    </div>
  );
}
