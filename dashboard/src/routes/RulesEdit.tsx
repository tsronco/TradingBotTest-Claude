import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import TriggerBuilder from '../components/rules/TriggerBuilder';
import type {
  ManualRule, Pattern, Cheatsheet, Goal, Proposal, Severity, Trigger,
} from '../lib/rules-types';

export default function RulesEdit() {
  const [params] = useSearchParams();
  const section = params.get('section') ?? 'manual';
  const id = params.get('id');

  return (
    <div className="p-3 md:p-6 max-w-2xl">
      <div className="text-mid text-[12px] mb-4">
        <span className="text-cyan">tim@dash</span><span className="text-dim">:</span>
        <span className="text-cyan">~/portfolio/rules/edit</span><span className="text-dim">$</span>{' '}
        <span className="text-fg">{id ? `vim ${section} ${id}` : `new ${section}`}</span>
      </div>
      {section === 'manual'      ? <ManualRuleForm id={id} />
      : section === 'patterns'    ? <PatternForm id={id} />
      : section === 'cheatsheets' ? <CheatsheetForm id={id} />
      : section === 'goals'       ? <GoalForm id={id} />
      : section === 'proposals'   ? <ProposalApproveForm id={id ?? ''} />
      : <div className="text-red text-[11px]">unknown section</div>}
    </div>
  );
}

const fieldCls = 'block w-full bg-panel-2 border border-border focus:border-cyan rounded-sm px-3 py-1.5 text-fg text-[12px] outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-mid text-[10px] tracking-[0.15em] uppercase mb-1">{label}</span>
      {children}
    </label>
  );
}

function FormButtons({ onSave, onCancel, disabled, saveLabel }: {
  onSave: () => void; onCancel: () => void; disabled?: boolean; saveLabel?: string;
}) {
  return (
    <div className="flex gap-2 pt-2">
      <button type="button" onClick={onSave} disabled={disabled} className="pbtn active border border-hi/60 text-hi">
        [{saveLabel ?? 'save'}]
      </button>
      <button type="button" onClick={onCancel} className="pbtn">
        [cancel]
      </button>
    </div>
  );
}

// --- Manual Rule Form ---

function ManualRuleForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'manual'],
    queryFn: () => api<{ rules: ManualRule[] }>('/api/rules/manual'),
    enabled: !!id,
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('warn');
  const [triggers, setTriggers] = useState<Trigger[]>([]);

  useEffect(() => {
    if (!id || !data) return;
    const rule = data.rules.find((r) => r.id === id);
    if (rule) {
      setTitle(rule.title);
      setBody(rule.body);
      setSeverity(rule.severity);
      setTriggers(rule.triggers);
    }
  }, [id, data]);

  const save = useMutation({
    mutationFn: () => {
      const payload = { title, body, severity, triggers };
      return id
        ? api('/api/rules/manual', { method: 'PATCH', body: JSON.stringify({ id, patch: payload }) })
        : api('/api/rules/manual', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'manual'] });
      nav('/rules');
    },
  });

  if (id && isLoading) return <div className="text-dim text-[11px]">loading…</div>;

  return (
    <div className="space-y-3">
      <h1 className="text-hi text-[14px] font-bold">{id ? 'edit rule' : 'new rule'}</h1>
      <Field label="title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} /></Field>
      <Field label="severity">
        <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={fieldCls}>
          <option value="warn">warn — banner only</option>
          <option value="block">block — override w/ reason required</option>
        </select>
      </Field>
      <div>
        <span className="block text-mid text-[10px] tracking-[0.15em] uppercase mb-1">triggers</span>
        <TriggerBuilder triggers={triggers} onChange={setTriggers} />
      </div>
      <Field label="body (plain English — what the AI grader sees)">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className={fieldCls} />
      </Field>
      <FormButtons
        onSave={() => save.mutate()}
        onCancel={() => nav('/rules')}
        disabled={!title || !body || save.isPending}
        saveLabel={save.isPending ? 'saving…' : 'save'}
      />
    </div>
  );
}

// --- Pattern Form ---

function PatternForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'patterns'],
    queryFn: () => api<{ items: Pattern[] }>('/api/rules/patterns'),
    enabled: !!id,
  });

  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [variables, setVariables] = useState('');
  const [legs, setLegs] = useState('');
  const [rulesText, setRulesText] = useState('');
  const [winRate, setWinRate] = useState('');

  useEffect(() => {
    if (!id || !data) return;
    const p = data.items.find((p) => p.id === id);
    if (p) {
      setName(p.name);
      setEnvironment(p.environment);
      setVariables(p.variables.join('\n'));
      setLegs(p.legs.join('\n'));
      setRulesText(p.rules.join('\n'));
      setWinRate(p.win_rate?.toString() ?? '');
    }
  }, [id, data]);

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name,
        environment,
        variables: variables.split('\n').map((s) => s.trim()).filter(Boolean),
        legs: legs.split('\n').map((s) => s.trim()).filter(Boolean),
        rules: rulesText.split('\n').map((s) => s.trim()).filter(Boolean),
      };
      if (winRate) payload.win_rate = parseFloat(winRate);
      return id
        ? api('/api/rules/patterns', { method: 'PATCH', body: JSON.stringify({ id, patch: payload }) })
        : api('/api/rules/patterns', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'patterns'] });
      nav('/rules');
    },
  });

  if (id && isLoading) return <div className="text-dim text-[11px]">loading…</div>;

  return (
    <div className="space-y-3">
      <h1 className="text-hi text-[14px] font-bold">{id ? 'edit pattern' : 'new pattern'}</h1>
      <Field label="name"><input value={name} onChange={(e) => setName(e.target.value)} className={fieldCls} /></Field>
      <Field label="environment">
        <input
          value={environment}
          onChange={(e) => setEnvironment(e.target.value)}
          placeholder="e.g. high IV, post-earnings dip"
          className={fieldCls}
        />
      </Field>
      <Field label="variables (one per line)">
        <textarea value={variables} onChange={(e) => setVariables(e.target.value)} rows={3} className={fieldCls} />
      </Field>
      <Field label="legs (one per line)">
        <textarea value={legs} onChange={(e) => setLegs(e.target.value)} rows={3} className={fieldCls} />
      </Field>
      <Field label="rules (one per line)">
        <textarea value={rulesText} onChange={(e) => setRulesText(e.target.value)} rows={3} className={fieldCls} />
      </Field>
      <Field label="win rate (0-1, optional)">
        <input value={winRate} onChange={(e) => setWinRate(e.target.value)} placeholder="0.65" className={fieldCls} />
      </Field>
      <FormButtons
        onSave={() => save.mutate()}
        onCancel={() => nav('/rules')}
        disabled={!name || !environment || save.isPending}
        saveLabel={save.isPending ? 'saving…' : 'save'}
      />
    </div>
  );
}

// --- Cheatsheet Form ---

function CheatsheetForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'cheatsheets'],
    queryFn: () => api<{ items: Cheatsheet[] }>('/api/rules/cheatsheets'),
    enabled: !!id,
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  useEffect(() => {
    if (!id || !data) return;
    const c = data.items.find((c) => c.id === id);
    if (c) { setTitle(c.title); setBody(c.body); }
  }, [id, data]);

  const save = useMutation({
    mutationFn: () => {
      const payload = { title, body };
      return id
        ? api('/api/rules/cheatsheets', { method: 'PATCH', body: JSON.stringify({ id, patch: payload }) })
        : api('/api/rules/cheatsheets', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'cheatsheets'] });
      nav('/rules');
    },
  });

  if (id && isLoading) return <div className="text-dim text-[11px]">loading…</div>;

  return (
    <div className="space-y-3">
      <h1 className="text-hi text-[14px] font-bold">{id ? 'edit cheatsheet' : 'new cheatsheet'}</h1>
      <Field label="title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} /></Field>
      <Field label="body (markdown)">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={fieldCls} />
      </Field>
      <FormButtons
        onSave={() => save.mutate()}
        onCancel={() => nav('/rules')}
        disabled={!title || save.isPending}
        saveLabel={save.isPending ? 'saving…' : 'save'}
      />
    </div>
  );
}

// --- Goal Form ---

function GoalForm({ id }: { id: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'goals'],
    queryFn: () => api<{ items: Goal[] }>('/api/rules/goals'),
    enabled: !!id,
  });

  const [body, setBody] = useState('');
  const [target, setTarget] = useState('');
  const [due, setDue] = useState('');

  useEffect(() => {
    if (!id || !data) return;
    const g = data.items.find((g) => g.id === id);
    if (g) {
      setBody(g.body);
      setTarget(g.target ?? '');
      setDue(g.due ?? '');
    }
  }, [id, data]);

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { body };
      if (target) payload.target = target;
      if (due) payload.due = due;
      return id
        ? api('/api/rules/goals', { method: 'PATCH', body: JSON.stringify({ id, patch: payload }) })
        : api('/api/rules/goals', { method: 'POST', body: JSON.stringify(payload) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'goals'] });
      nav('/rules');
    },
  });

  if (id && isLoading) return <div className="text-dim text-[11px]">loading…</div>;

  return (
    <div className="space-y-3">
      <h1 className="text-hi text-[14px] font-bold">{id ? 'edit goal' : 'new goal'}</h1>
      <Field label="body"><input value={body} onChange={(e) => setBody(e.target.value)} className={fieldCls} /></Field>
      <Field label="target (optional)">
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. $5000 / 52 contracts" className={fieldCls} />
      </Field>
      <Field label="due (optional, YYYY-MM-DD)">
        <input value={due} onChange={(e) => setDue(e.target.value)} className={fieldCls} />
      </Field>
      <FormButtons
        onSave={() => save.mutate()}
        onCancel={() => nav('/rules')}
        disabled={!body || save.isPending}
        saveLabel={save.isPending ? 'saving…' : 'save'}
      />
    </div>
  );
}

// --- Proposal Approve Form (edit-then-approve) ---

function ProposalApproveForm({ id }: { id: string }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules', 'proposals'],
    queryFn: () => api<{ proposals: Proposal[] }>('/api/rules/proposals'),
  });

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('warn');
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [reasoning, setReasoning] = useState('');

  useEffect(() => {
    if (!data) return;
    const p = data.proposals.find((p) => p.id === id);
    if (p) {
      setTitle(p.proposed_rule.title);
      setBody(p.proposed_rule.body);
      setSeverity(p.proposed_rule.severity);
      setTriggers(p.proposed_rule.triggers);
      setReasoning(p.reasoning);
    }
  }, [id, data]);

  const save = useMutation({
    mutationFn: () =>
      api('/api/rules/proposals', {
        method: 'POST',
        body: JSON.stringify({
          action: 'edit-and-approve',
          proposal_id: id,
          edits: { title, body, severity, triggers },
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'proposals'] });
      qc.invalidateQueries({ queryKey: ['rules', 'manual'] });
      nav('/rules');
    },
  });

  if (isLoading) return <div className="text-dim text-[11px]">loading…</div>;

  return (
    <div className="space-y-3">
      <h1 className="text-hi text-[14px] font-bold">edit proposed rule before adding</h1>
      {reasoning && <div className="text-[10px] text-mid italic border border-border bg-panel-2/30 p-2 rounded-sm">{reasoning}</div>}
      <Field label="title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldCls} /></Field>
      <Field label="severity">
        <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} className={fieldCls}>
          <option value="warn">warn</option>
          <option value="block">block</option>
        </select>
      </Field>
      <div>
        <span className="block text-mid text-[10px] tracking-[0.15em] uppercase mb-1">triggers</span>
        <TriggerBuilder triggers={triggers} onChange={setTriggers} />
      </div>
      <Field label="body">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className={fieldCls} />
      </Field>
      <FormButtons
        onSave={() => save.mutate()}
        onCancel={() => nav('/rules')}
        disabled={!title || save.isPending}
        saveLabel={save.isPending ? 'saving…' : 'add to my rules'}
      />
    </div>
  );
}
