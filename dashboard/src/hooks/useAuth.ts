import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

interface SessionResponse {
  authenticated: boolean;
  session?: { sub: string; loggedInAt: number };
}

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: () => api<SessionResponse>('/api/auth/session'),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session'] }),
  });
}
