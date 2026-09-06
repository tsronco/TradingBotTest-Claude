import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

// Themed Markdown renderer for user-authored notes (cheatsheets, etc.).
// GFM enabled → pipe tables, task lists, strikethrough, autolinks all render.
// Raw HTML is intentionally NOT enabled (no rehype-raw), so pasted content
// can't inject markup — only Markdown structure is honored.
//
// Every element is mapped to the terminal palette tokens so it matches the
// rest of the dashboard. Tables scroll horizontally inside their own box so a
// wide table never blows out the page width on mobile.
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="text-hi font-bold text-[15px] mt-3 mb-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-hi font-bold text-[13px] mt-3 mb-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-fg font-bold text-[12px] mt-3 mb-1 first:mt-0 uppercase tracking-[0.1em]">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="text-fg font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic text-fg/90">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-cyan hover:underline">{children}</a>
  ),
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-mid italic">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    // Fenced block (has a language- class) vs inline code.
    const isBlock = /language-/.test(className || '');
    if (isBlock) {
      return (
        <pre className="bg-panel-2/60 border border-border rounded-sm p-2.5 my-2 overflow-x-auto text-[11px]">
          <code className="text-fg/90">{children}</code>
        </pre>
      );
    }
    return <code className="bg-panel-2/60 text-cyan px-1 py-0.5 rounded-sm text-[11px]">{children}</code>;
  },
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-[11px] tnum">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="text-dim uppercase tracking-[0.1em] text-[10px]">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border/60">{children}</tr>,
  th: ({ children, style }) => (
    <th className="border border-border px-2 py-1 text-left font-normal bg-panel-2/40" style={style}>{children}</th>
  ),
  td: ({ children, style }) => (
    <td className="border border-border px-2 py-1 align-top" style={style}>{children}</td>
  ),
};

export default function Markdown({
  children, className = '', muted = true,
}: {
  children: string;
  className?: string;
  // muted=true applies the default dimmed body color; pass false to inherit the
  // parent's color (e.g. a checked goal that must show strikethrough + dim).
  muted?: boolean;
}) {
  return (
    <div className={`md-body ${muted ? 'text-fg/85 ' : ''}${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
