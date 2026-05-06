export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let body: any = null;
    try { body = await res.json(); } catch { /* ignore */ }
    // Include `detail` when the server provides it. Endpoints like
    // /api/trades/submit return { error: 'alpaca_order_failed', detail: '...' };
    // showing only `error` strips the actionable diagnostic.
    const code = body?.error ?? `request_failed_${res.status}`;
    const message = body?.detail ? `${code}: ${body.detail}` : code;
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}
