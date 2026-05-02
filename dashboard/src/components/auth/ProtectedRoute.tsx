import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../../hooks/useAuth';

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { data, isLoading } = useSession();

  if (isLoading) {
    return <div className="p-6 text-muted text-sm">Loading…</div>;
  }
  if (!data?.authenticated) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <>{children}</>;
}
