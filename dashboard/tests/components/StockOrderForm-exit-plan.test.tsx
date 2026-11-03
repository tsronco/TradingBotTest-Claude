import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StockOrderForm } from '../../src/components/order/StockOrderForm';

beforeEach(() => {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/alpaca/quote')) {
      return Promise.resolve(new Response(JSON.stringify({ snapshot: { CMG: { latestQuote: { ap: 33.0, bp: 32.9 } } } }), { status: 200 }));
    }
    if (url.includes('/api/settings/tags')) return Promise.resolve(new Response(JSON.stringify({ tags: [] }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ positions: [], account: {} }), { status: 200 }));
  });
});

function renderForm(onReview = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StockOrderForm symbol="CMG" account="live" setAccount={() => {}} onReview={onReview} />
    </QueryClientProvider>,
  );
}

describe('StockOrderForm — optional exit plan', () => {
  it('shows your stop/target inputs and the bot\'s stop for a buy', async () => {
    renderForm();
    expect(screen.getByText(/exit plan \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText('your stop')).toBeInTheDocument();
    expect(screen.getByLabelText('your target')).toBeInTheDocument();
    // limit defaults to the ask (33.00) once the quote lands → bot stop 29.70
    await waitFor(() => expect(screen.getByTestId('bot-stop-hint')).toHaveTextContent('$29.70'));
  });

  it('hides the section for a closing sell', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /^\[sell\]$/ }));
    expect(screen.queryByText(/exit plan \(optional\)/i)).toBeNull();
  });

  it('sends the plan with the order preview', async () => {
    let sent: any = null;
    (globalThis.fetch as any).mockImplementation((url: string, init?: any) => {
      if (url.includes('/api/trades/preview')) {
        sent = JSON.parse(init.body);
        return Promise.resolve(new Response(JSON.stringify({ exposure: 0, requires_totp: false, rule_warnings: [], validation_errors: [] }), { status: 200 }));
      }
      if (url.includes('/api/alpaca/quote')) {
        return Promise.resolve(new Response(JSON.stringify({ snapshot: { CMG: { latestQuote: { ap: 33.0, bp: 32.9 } } } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ tags: [], positions: [], account: {} }), { status: 200 }));
    });
    const onReview = vi.fn();
    renderForm(onReview);
    fireEvent.change(screen.getByLabelText('your stop'), { target: { value: '29' } });
    fireEvent.change(screen.getByLabelText('your target'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: /review/i }));
    await waitFor(() => expect(onReview).toHaveBeenCalled());
    expect(sent).toEqual(expect.objectContaining({ planned_stop: 29, planned_target: 40 }));
  });
});
