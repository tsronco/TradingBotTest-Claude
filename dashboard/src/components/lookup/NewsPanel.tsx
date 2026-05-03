import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface NewsArticle {
  id: number;
  headline?: string;
  Headline?: string;
  source?: string;
  Source?: string;
  created_at?: string;
  CreatedAt?: string;
  url?: string;
  URL?: string;
}

function fmtNewsTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function NewsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['news', symbol],
    queryFn: () => api<{ news: NewsArticle[] }>(`/api/alpaca/news?symbol=${symbol}&limit=10`),
  });
  if (isLoading) return <div className="text-dim text-[11px]">loading news…</div>;
  const news = data?.news ?? [];
  if (news.length === 0) return <div className="text-dim text-[11px]">no recent news.</div>;
  return (
    <ul className="divide-y divide-border/60">
      {news.slice(0, 6).map((n) => {
        const url = n.URL ?? n.url;
        const created = n.CreatedAt ?? n.created_at ?? '';
        const source = n.Source ?? n.source ?? '';
        const headline = n.Headline ?? n.headline ?? '';
        return (
          <li key={n.id}>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block py-2 hover:bg-panel-2/40 -mx-2 px-2 transition-colors group"
            >
              <div className="text-dim text-[10px] tracking-[0.1em] flex items-center gap-2">
                <span className="text-mid">▸</span>
                <span className="tnum">{fmtNewsTime(created)}</span>
                {source && <><span>·</span><span className="text-mid">{source}</span></>}
              </div>
              <div className="text-fg text-[12px] leading-snug mt-0.5 group-hover:text-hi transition-colors">
                {headline}
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
