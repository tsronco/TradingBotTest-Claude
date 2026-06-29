// dashboard/src/hooks/useRules.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  ManualRule, Pattern, Cheatsheet, Goal, Tendency, Proposal, BotRulesPayload,
} from '../lib/rules-types';

export function useManualRules() {
  return useQuery({
    queryKey: ['rules', 'manual'],
    queryFn: () => api<{ rules: ManualRule[] }>('/api/rules/manual'),
  });
}

export function usePatterns() {
  return useQuery({
    queryKey: ['rules', 'patterns'],
    queryFn: () => api<{ items: Pattern[] }>('/api/rules/patterns'),
  });
}

export function useCheatsheets() {
  return useQuery({
    queryKey: ['rules', 'cheatsheets'],
    queryFn: () => api<{ items: Cheatsheet[] }>('/api/rules/cheatsheets'),
  });
}

export function useGoals() {
  return useQuery({
    queryKey: ['rules', 'goals'],
    queryFn: () => api<{ items: Goal[] }>('/api/rules/goals'),
  });
}

export function useTendencies() {
  return useQuery({
    queryKey: ['rules', 'tendencies'],
    queryFn: () => api<{ tendencies: Tendency[] }>('/api/rules/tendencies'),
  });
}

export function useProposals() {
  return useQuery({
    queryKey: ['rules', 'proposals'],
    queryFn: () => api<{ proposals: Proposal[] }>('/api/rules/proposals'),
  });
}

export function useBotRules() {
  return useQuery({
    queryKey: ['rules', 'bot'],
    queryFn: () => api<{ manual: BotRulesPayload | null; live: BotRulesPayload | null }>('/api/rules/bot'),
  });
}

// --- Mutations ---

export function useDeleteRule(resource: 'manual' | 'patterns' | 'cheatsheets' | 'goals') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/api/rules/${resource}`, { method: 'DELETE', body: JSON.stringify({ id }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', resource] }),
  });
}

export function useApproveProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposal_id: string) =>
      api('/api/rules/proposals', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', proposal_id }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rules', 'proposals'] });
      qc.invalidateQueries({ queryKey: ['rules', 'manual'] });
    },
  });
}

export function useDismissProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposal_id: string) =>
      api('/api/rules/proposals', {
        method: 'POST',
        body: JSON.stringify({ action: 'dismiss', proposal_id }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules', 'proposals'] }),
  });
}
