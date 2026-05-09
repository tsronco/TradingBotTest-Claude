import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from './routes/Login';
import Home from './routes/Home';
import Positions from './routes/Positions';
import Orders from './routes/Orders';
import Lookup from './routes/Lookup';
import Settings from './routes/Settings';
import OrderNew from './routes/OrderNew';
import Rules from './routes/Rules';
import RulesEdit from './routes/RulesEdit';
import TradeDetail from './routes/TradeDetail';
import Trades from './routes/Trades';
import Watchlist from './routes/Watchlist';
import Calendar from './routes/Calendar';
import Performance from './routes/Performance';
import ProtectedRoute from './components/auth/ProtectedRoute';
import AppShell from './components/layout/AppShell';

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Home />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/lookup/:symbol" element={<Lookup />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/order/new" element={<OrderNew />} />
            <Route path="/trade/:id" element={<TradeDetail />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/rules/edit" element={<RulesEdit />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/performance" element={<Performance />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
