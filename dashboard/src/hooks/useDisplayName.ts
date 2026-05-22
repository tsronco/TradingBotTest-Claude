import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export const DEFAULT_DISPLAY_NAME = 'trader';

interface DisplayNameResponse {
  display_name: string;
}

export function useDisplayName() {
  const q = useQuery({
    queryKey: ['display-name'],
    queryFn: () => api<DisplayNameResponse>('/api/settings/display-name'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const name = q.data?.display_name?.trim() || DEFAULT_DISPLAY_NAME;
  return {
    name,
    handle: name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    upper: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    isLoading: q.isLoading,
  };
}

export function useSaveDisplayName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (display_name: string) =>
      api<DisplayNameResponse>('/api/settings/display-name', {
        method: 'POST',
        body: JSON.stringify({ display_name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['display-name'] }),
  });
}
