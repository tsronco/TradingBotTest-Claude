import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface NewsArticle {
  id: number;
  headline: string;
  source: string;
  created_at: string;
  url: string;
}

export default function NewsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['news', symbol],
    queryFn: () => api<{ news: NewsArticle[] }>(`/api/alpaca/news?symbol=${symbol}&limit=10`),
  });
  if (isLoading) return <div className="text-muted text-xs">Loading news…</div>;
  const news = (data?.news ?? []) as any[];
  if (news.length === 0) return <div className="text-muted text-xs">No recent news.</div>;
  return (
    <div className="space-y-2">
      {news.slice(0, 5).map((n) => (
        <a key={n.id} href={n.URL ?? n.url} target="_blank" rel="noreferrer" className="block hover:bg-panel-2/40 rounded p-1 -m-1">
          <div className="text-muted text-[10px]">
            {new Date(n.CreatedAt ?? n.created_at).toLocaleTimeString()} · {n.Source ?? n.source}
          </div>
          <div className="text-text text-xs leading-tight mt-0.5">
            {n.Headline ?? n.headline}
          </div>
        </a>
      ))}
    </div>
  );
}
