# Trading Dashboard — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only foundation of the trading dashboard — auth, Vercel KV, bot-state push contract, and five pages (`/login`, `/`, `/positions`, `/orders`, `/lookup/:symbol`) deployed to `dash.fattieslearnscoding.com`.

**Architecture:** Vite + React 19 + Tailwind v4 SPA in a new `dashboard/` subdirectory of the existing `TradingBotTest-Claude` repo. Vercel serverless functions in `dashboard/api/` (TypeScript for everything except `fundamentals.py` which uses the Python runtime for yfinance). Vercel KV (Upstash Redis via Marketplace) holds bot-state and the watchlist. The five existing GitHub Actions workflows get a one-line `curl` step that POSTs their state JSON to `/api/bot-state` after each run — bots stay otherwise untouched.

**Tech Stack:**
- Frontend: React 19, Vite 6, Tailwind CSS 4, react-router-dom 6, @tanstack/react-query 5, lucide-react, zod
- Server (Vercel Functions, Node runtime): `@upstash/redis`, `@alpacahq/typescript-sdk`, `otplib`, `cookie`, `zod`
- Server (Vercel Functions, Python runtime): `yfinance` (one endpoint only)
- Testing: vitest, @vitest/ui
- Deployment: Vercel (root directory `dashboard/`), domain `dash.fattieslearnscoding.com`

**Repo placement:** Dashboard lives at `dashboard/` in the existing `TradingBotTest-Claude` repo. Keeps the dashboard code next to the bots it observes; one PR can update both sides of the bot-state contract.

---

## File map

Files this plan creates or modifies. Used as a reference; each task lists exact paths.

```
TradingBotTest-Claude/                    # existing repo root
├── .github/workflows/                    # MODIFY — add curl step
│   ├── tsla-monitor.yml
│   ├── tsla-monitor-aggressive.yml
│   └── congress-copy.yml
├── dashboard/                            # NEW — entire subdirectory
│   ├── api/                              # Vercel serverless functions
│   │   ├── _lib/                         # shared server-only helpers
│   │   │   ├── alpaca.ts
│   │   │   ├── kv.ts
│   │   │   ├── kv-keys.ts
│   │   │   ├── session.ts
│   │   │   ├── totp.ts
│   │   │   └── auth-guard.ts
│   │   ├── alpaca/
│   │   │   ├── account.ts
│   │   │   ├── positions.ts
│   │   │   ├── orders.ts
│   │   │   ├── quote.ts
│   │   │   ├── chain.ts
│   │   │   ├── news.ts
│   │   │   └── bars.ts
│   │   ├── auth/
│   │   │   ├── login.ts
│   │   │   ├── logout.ts
│   │   │   └── session.ts
│   │   ├── kv/
│   │   │   ├── bot-state.ts
│   │   │   └── watchlist.ts
│   │   ├── bot-state.ts                  # the bot push webhook
│   │   └── fundamentals.py               # yfinance Python edge function
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes/
│   │   │   ├── Login.tsx
│   │   │   ├── Home.tsx
│   │   │   ├── Positions.tsx
│   │   │   ├── Orders.tsx
│   │   │   └── Lookup.tsx
│   │   ├── components/
│   │   │   ├── auth/ProtectedRoute.tsx
│   │   │   ├── layout/Sidebar.tsx
│   │   │   ├── layout/AppShell.tsx
│   │   │   ├── account/AccountSelector.tsx
│   │   │   ├── account/AccountCard.tsx
│   │   │   ├── lookup/QuotePanel.tsx
│   │   │   ├── lookup/PositionContextPanel.tsx
│   │   │   ├── lookup/TradingViewChart.tsx
│   │   │   ├── lookup/OptionsChain.tsx
│   │   │   ├── lookup/WheelabilityPanel.tsx
│   │   │   ├── lookup/NewsPanel.tsx
│   │   │   ├── lookup/EarningsPanel.tsx
│   │   │   └── lookup/FundamentalsPanel.tsx
│   │   ├── hooks/
│   │   │   ├── useAccount.ts
│   │   │   └── useAuth.ts
│   │   ├── lib/
│   │   │   ├── api.ts                    # client-side fetch wrapper
│   │   │   ├── format.ts                 # $/% formatters
│   │   │   └── wheelability.ts           # port of wheel scoring
│   │   ├── styles/globals.css
│   │   └── vite-env.d.ts
│   ├── tests/
│   │   ├── api/
│   │   │   ├── bot-state.test.ts
│   │   │   └── auth-login.test.ts
│   │   └── lib/
│   │       ├── totp.test.ts
│   │       ├── session.test.ts
│   │       └── kv-keys.test.ts
│   ├── .env.example
│   ├── .gitignore
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── vercel.json
│   ├── requirements.txt                  # for the Python function
│   └── README.md
```

---

## Milestone 0 — Project scaffold

### Task 1: Create the Vite + React + TypeScript scaffold

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/index.html`
- Create: `dashboard/src/main.tsx`
- Create: `dashboard/src/App.tsx`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/tsconfig.node.json`
- Create: `dashboard/vite.config.ts`
- Create: `dashboard/.gitignore`
- Create: `dashboard/vite-env.d.ts`

- [ ] **Step 1: Create the dashboard directory and run the Vite scaffold non-interactively**

```bash
cd "C:/Users/fatti/OneDrive/Documents/Coding Files/TradingBotTest-Claude/.claude/worktrees/sharp-dewdney-2cabdd"
mkdir -p dashboard
cd dashboard
npm create vite@latest . -- --template react-ts
```

When prompted "Current directory is not empty. Please choose how to proceed", select "Ignore files and continue" (or run with `--force` if available).

- [ ] **Step 2: Install base deps**

```bash
cd dashboard
npm install
```

- [ ] **Step 3: Verify the dev server boots**

```bash
npm run dev
```

Expected: Vite prints `Local: http://localhost:5173/`. Open the URL, see the default Vite + React landing page. Then Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
cd ..
git add dashboard/
git commit -m "scaffold: vite + react + ts dashboard subproject"
```

---

### Task 2: Add Tailwind CSS v4

**Files:**
- Create: `dashboard/postcss.config.js`
- Create: `dashboard/tailwind.config.ts`
- Create: `dashboard/src/styles/globals.css`
- Modify: `dashboard/src/main.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Install Tailwind v4 + PostCSS**

```bash
cd dashboard
npm install -D tailwindcss@^4 @tailwindcss/postcss postcss autoprefixer
```

- [ ] **Step 2: Create `postcss.config.js`**

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Create `tailwind.config.ts`**

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0c10',
        panel: '#161a20',
        'panel-2': '#1f242c',
        border: '#262b33',
        muted: '#7d8593',
        text: '#cdd5e0',
        'text-strong': '#e6e6e6',
        accent: '#ffb84d',
        green: '#5cd97e',
        red: '#ff6b6b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 4: Replace `src/styles/globals.css`**

```css
@import 'tailwindcss';

html, body, #root {
  height: 100%;
}

body {
  background: theme('colors.bg');
  color: theme('colors.text');
  font-family: theme('fontFamily.mono');
  font-size: 13px;
  margin: 0;
}
```

- [ ] **Step 5: Replace `src/main.tsx` to import the new globals**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6: Replace `src/App.tsx` with a smoke-test component**

```tsx
export default function App() {
  return (
    <div className="p-6">
      <h1 className="text-text-strong text-2xl font-bold">Dashboard scaffold</h1>
      <p className="text-muted mt-2">If this is dark with orange-ish accents, Tailwind is wired up.</p>
    </div>
  );
}
```

- [ ] **Step 7: Delete unused default files**

```bash
rm -f src/App.css src/index.css src/assets/react.svg
```

- [ ] **Step 8: Run dev server and verify**

```bash
npm run dev
```

Expected: dark background, bold heading. Ctrl-C to stop.

- [ ] **Step 9: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): wire up tailwind v4 with dark theme tokens"
```

---

### Task 3: Add testing (vitest)

**Files:**
- Create: `dashboard/vitest.config.ts`
- Modify: `dashboard/package.json`
- Create: `dashboard/tests/sanity.test.ts`

- [ ] **Step 1: Install vitest**

```bash
cd dashboard
npm install -D vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 3: Create `tests/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Create a sanity test at `tests/sanity.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Add scripts to `package.json`**

In `dashboard/package.json`, replace the `"scripts"` block:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc -b && vite build",
  "lint": "eslint .",
  "preview": "vite preview",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 6: Run the sanity test**

```bash
npm test
```

Expected: `1 passed`. If failure, fix before continuing.

- [ ] **Step 7: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): add vitest setup with sanity test"
```

---

### Task 4: Add core runtime deps

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: Install client-side deps**

```bash
cd dashboard
npm install react-router-dom@^6 @tanstack/react-query@^5 zod lucide-react
```

- [ ] **Step 2: Install server-side deps for the Vercel functions**

```bash
npm install @upstash/redis @alpacahq/typescript-sdk otplib cookie
npm install -D @vercel/node @types/cookie
```

- [ ] **Step 3: Verify build still passes**

```bash
npm run build
```

Expected: build completes, prints output to `dist/`.

- [ ] **Step 4: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): install router, query, alpaca + upstash + totp deps"
```

---

### Task 5: Vercel project + env-var template

**Files:**
- Create: `dashboard/vercel.json`
- Create: `dashboard/.env.example`
- Create: `dashboard/README.md`

- [ ] **Step 1: Create `vercel.json`**

This routes everything not under `/api` or a static asset to `index.html` (SPA fallback).

```json
{
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

- [ ] **Step 2: Create `.env.example`**

This documents every env var the app needs. Real values go into Vercel's dashboard, never into git.

```bash
# === Auth ===
DASHBOARD_PASSWORD=change-me-to-a-32-char-random-string
TOTP_SECRET=base32-secret-from-otpauth-uri
SESSION_SECRET=64-char-random-string-for-cookie-signing
BACKUP_CODES=hashed-comma-separated-list-of-8-codes

# === Bot push ===
BOT_PUSH_TOKEN=64-char-random-string-shared-with-github-actions

# === Alpaca paper accounts ===
ALPACA_API_KEY=PKxxxxxxxxxxx
ALPACA_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_AGG_API_KEY=PKxxxxxxxxxxx
ALPACA_AGG_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2

# === Alpaca data ===
# Same key works for market data on paper account
ALPACA_DATA_BASE_URL=https://data.alpaca.markets/v2

# === Vercel KV (Upstash Redis) — auto-provisioned by the Marketplace integration ===
# DO NOT set these manually in .env — they come from the integration.
# KV_REST_API_URL=
# KV_REST_API_TOKEN=
```

- [ ] **Step 3: Create `dashboard/README.md`**

```markdown
# Trading Dashboard

Personal Vercel-hosted dashboard for monitoring the TradingBotTest-Claude bots and placing manual trades.
See [docs/superpowers/specs/2026-05-02-trading-dashboard-design.md](../docs/superpowers/specs/2026-05-02-trading-dashboard-design.md).

## Local development

```bash
npm install
cp .env.example .env       # then fill in real values
npm run dev                # Vite dev server on :5173
```

## Tests

```bash
npm test
```

## Deploy

This app is deployed to Vercel from the `dashboard/` subdirectory.
See [DEPLOY.md](./DEPLOY.md) (added in Task 38) for first-time setup.
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): vercel.json + env template + readme"
```

---

## Milestone 1 — KV + bot-state push contract

This is the highest-risk milestone — it touches both repos. We do it early so any breakage shows up before we've built a lot on top.

### Task 6: KV key whitelist + KV client wrapper (with tests)

**Files:**
- Create: `dashboard/api/_lib/kv-keys.ts`
- Create: `dashboard/api/_lib/kv.ts`
- Create: `dashboard/tests/lib/kv-keys.test.ts`

- [ ] **Step 1: Write the failing test for the key whitelist**

`dashboard/tests/lib/kv-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAllowedBotStateKey, BOT_STATE_KEYS } from '../../api/_lib/kv-keys';

describe('kv-keys', () => {
  it('accepts every key in the whitelist', () => {
    for (const k of BOT_STATE_KEYS) {
      expect(isAllowedBotStateKey(k)).toBe(true);
    }
  });

  it('rejects keys not in the whitelist', () => {
    expect(isAllowedBotStateKey('bot:state:made-up')).toBe(false);
    expect(isAllowedBotStateKey('session:abc')).toBe(false);
    expect(isAllowedBotStateKey('')).toBe(false);
  });

  it('exposes the expected five keys', () => {
    expect(BOT_STATE_KEYS).toEqual([
      'bot:state:conservative',
      'bot:state:aggressive',
      'bot:strategy:conservative',
      'bot:strategy:aggressive',
      'bot:congress',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd dashboard
npm test -- tests/lib/kv-keys.test.ts
```

Expected: FAIL — `Cannot find module '../../api/_lib/kv-keys'`.

- [ ] **Step 3: Implement `api/_lib/kv-keys.ts`**

```ts
export const BOT_STATE_KEYS = [
  'bot:state:conservative',
  'bot:state:aggressive',
  'bot:strategy:conservative',
  'bot:strategy:aggressive',
  'bot:congress',
] as const;

export type BotStateKey = (typeof BOT_STATE_KEYS)[number];

export function isAllowedBotStateKey(key: string): key is BotStateKey {
  return (BOT_STATE_KEYS as readonly string[]).includes(key);
}

export function lastUpdateKey(key: BotStateKey): string {
  return `bot:last-update:${key}`;
}

export const KV_KEYS = {
  watchlist: 'watchlist',
  totpThresholds: 'config:totp_thresholds',
  sessionPrefix: 'session:',
} as const;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/lib/kv-keys.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Implement the thin Upstash wrapper at `api/_lib/kv.ts`**

This is wrapped so other server code never imports `@upstash/redis` directly — keeps test mocking simple.

```ts
import { Redis } from '@upstash/redis';

let _redis: Redis | null = null;

export function kv(): Redis {
  if (!_redis) {
    _redis = Redis.fromEnv();   // reads KV_REST_API_URL + KV_REST_API_TOKEN
  }
  return _redis;
}

// Convenience helpers used across the codebase.
export async function getJson<T>(key: string): Promise<T | null> {
  return (await kv().get<T>(key)) ?? null;
}

export async function setJson<T>(key: string, value: T): Promise<void> {
  await kv().set(key, value);
}
```

- [ ] **Step 6: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): kv key whitelist + upstash wrapper"
```

---

### Task 7: `/api/bot-state` webhook endpoint (with tests)

**Files:**
- Create: `dashboard/api/bot-state.ts`
- Create: `dashboard/tests/api/bot-state.test.ts`

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/api/bot-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import handler from '../../api/bot-state';
import * as kvModule from '../../api/_lib/kv';

const kvSet = vi.fn();
beforeEach(() => {
  kvSet.mockReset();
  vi.spyOn(kvModule, 'kv').mockReturnValue({ set: kvSet } as any);
  process.env.BOT_PUSH_TOKEN = 'test-token-123';
});

function makeReqRes(opts: {
  method?: string;
  auth?: string;
  body?: any;
}) {
  const req: any = {
    method: opts.method ?? 'POST',
    headers: { authorization: opts.auth, 'content-type': 'application/json' },
    body: opts.body,
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.body = payload; return this; },
    end() { return this; },
  };
  return { req, res };
}

describe('POST /api/bot-state', () => {
  it('returns 405 on GET', async () => {
    const { req, res } = makeReqRes({ method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('returns 401 with no bearer token', async () => {
    const { req, res } = makeReqRes({ body: { key: 'bot:state:conservative', payload: {} } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 401 with the wrong bearer token', async () => {
    const { req, res } = makeReqRes({ auth: 'Bearer wrong', body: { key: 'bot:state:conservative', payload: {} } });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 400 on a key not in the whitelist', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:made-up', payload: { x: 1 } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('returns 400 on missing payload', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:conservative' },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('writes payload + last-update timestamp on a valid request', async () => {
    const { req, res } = makeReqRes({
      auth: 'Bearer test-token-123',
      body: { key: 'bot:state:conservative', payload: { hello: 'world' } },
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(kvSet).toHaveBeenCalledWith('bot:state:conservative', { hello: 'world' });
    expect(kvSet).toHaveBeenCalledWith(
      'bot:last-update:bot:state:conservative',
      expect.any(String)
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd dashboard
npm test -- tests/api/bot-state.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `api/bot-state.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from './_lib/kv';
import { isAllowedBotStateKey, lastUpdateKey } from './_lib/kv-keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization ?? '';
  const expected = `Bearer ${process.env.BOT_PUSH_TOKEN ?? ''}`;
  if (!process.env.BOT_PUSH_TOKEN || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body as { key?: string; payload?: unknown } | undefined;
  if (!body || typeof body.key !== 'string' || !isAllowedBotStateKey(body.key)) {
    return res.status(400).json({ error: 'invalid_or_unknown_key' });
  }
  if (body.payload === undefined || body.payload === null) {
    return res.status(400).json({ error: 'missing_payload' });
  }

  const k = body.key;
  await kv().set(k, body.payload);
  await kv().set(lastUpdateKey(k), new Date().toISOString());

  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- tests/api/bot-state.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /api/bot-state webhook with bearer auth + key whitelist"
```

---

### Task 8: Add curl push step to `tsla-monitor.yml`

**Files:**
- Modify: `.github/workflows/tsla-monitor.yml`

- [ ] **Step 1: Read the existing workflow**

```bash
cat .github/workflows/tsla-monitor.yml
```

Note where the script ends and what files it writes (`wheel_state.json` and `strategy_state.json`).

- [ ] **Step 2: Append two new steps just before any existing "commit and push state" step**

In `.github/workflows/tsla-monitor.yml`, find the "commit state files" step (or the end of the job if no such step exists). Insert these two steps **before** the commit step (so they run after state files are written):

```yaml
      - name: Push wheel state to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          if [ -f wheel_state.json ]; then
            curl -fsS --max-time 10 \
              -X POST https://dash.fattieslearnscoding.com/api/bot-state \
              -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --slurpfile p wheel_state.json \
                         '{key: "bot:state:conservative", payload: $p[0]}')" \
              || echo "Dashboard push for wheel state failed (non-fatal)"
          else
            echo "wheel_state.json not present — skipping dashboard push"
          fi

      - name: Push strategy state to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          if [ -f strategy_state.json ]; then
            curl -fsS --max-time 10 \
              -X POST https://dash.fattieslearnscoding.com/api/bot-state \
              -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --slurpfile p strategy_state.json \
                         '{key: "bot:strategy:conservative", payload: $p[0]}')" \
              || echo "Dashboard push for strategy state failed (non-fatal)"
          else
            echo "strategy_state.json not present — skipping dashboard push"
          fi
```

The three things this guarantees:
1. `if: always()` — runs even if the bot logic errored.
2. `--max-time 10` — workflow doesn't block on a slow dashboard.
3. `||` failure-swallow — bots keep working even if the dashboard is down.

- [ ] **Step 3: Validate the YAML**

```bash
cat .github/workflows/tsla-monitor.yml | python -c "import sys, yaml; yaml.safe_load(sys.stdin); print('OK')"
```

Expected: `OK`. If parse error, fix before continuing.

- [ ] **Step 4: Commit (don't push yet — we'll wire other workflows together)**

```bash
git add .github/workflows/tsla-monitor.yml
git commit -m "feat(workflows): push conservative wheel + strategy state to dashboard"
```

---

### Task 9: Add curl push step to `tsla-monitor-aggressive.yml`

**Files:**
- Modify: `.github/workflows/tsla-monitor-aggressive.yml`

- [ ] **Step 1: Read the existing workflow**

```bash
cat .github/workflows/tsla-monitor-aggressive.yml
```

- [ ] **Step 2: Append two new steps before the commit step**

```yaml
      - name: Push wheel state (aggressive) to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          if [ -f wheel_state_aggressive.json ]; then
            curl -fsS --max-time 10 \
              -X POST https://dash.fattieslearnscoding.com/api/bot-state \
              -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --slurpfile p wheel_state_aggressive.json \
                         '{key: "bot:state:aggressive", payload: $p[0]}')" \
              || echo "Dashboard push for aggressive wheel state failed (non-fatal)"
          else
            echo "wheel_state_aggressive.json not present — skipping dashboard push"
          fi

      - name: Push strategy state (aggressive) to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          if [ -f strategy_state_aggressive.json ]; then
            curl -fsS --max-time 10 \
              -X POST https://dash.fattieslearnscoding.com/api/bot-state \
              -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --slurpfile p strategy_state_aggressive.json \
                         '{key: "bot:strategy:aggressive", payload: $p[0]}')" \
              || echo "Dashboard push for aggressive strategy state failed (non-fatal)"
          else
            echo "strategy_state_aggressive.json not present — skipping dashboard push"
          fi
```

- [ ] **Step 3: Validate YAML**

```bash
cat .github/workflows/tsla-monitor-aggressive.yml | python -c "import sys, yaml; yaml.safe_load(sys.stdin); print('OK')"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/tsla-monitor-aggressive.yml
git commit -m "feat(workflows): push aggressive wheel + strategy state to dashboard"
```

---

### Task 10: Add curl push step to `congress-copy.yml`

**Files:**
- Modify: `.github/workflows/congress-copy.yml`

The congress-copy workflow's state lives in a SQLite DB (`congress-copy/data/state.db`), not JSON. We push a *summary* — the recent disclosures it has copied — as JSON so the dashboard has something useful without us serializing the whole DB.

- [ ] **Step 1: Read the existing workflow + figure out where state lives**

```bash
cat .github/workflows/congress-copy.yml
ls congress-copy/data/
```

- [ ] **Step 2: Add a summary-build step + push step before the commit**

Insert these two steps before the existing "commit state" step:

```yaml
      - name: Build congress state summary
        if: always()
        run: |
          # Summarize the SQLite DB into a small JSON payload for the dashboard.
          # Fields: recent_copies (last 30 days), open_positions, last_run.
          python - <<'PY'
          import json, sqlite3, os, datetime
          db_path = "congress-copy/data/state.db"
          summary = {"last_run": datetime.datetime.utcnow().isoformat() + "Z"}
          if os.path.exists(db_path):
              conn = sqlite3.connect(db_path)
              cur = conn.cursor()
              try:
                  cur.execute("""
                    SELECT politician, symbol, side, qty, copied_at
                    FROM trades
                    WHERE copied_at >= datetime('now', '-30 days')
                    ORDER BY copied_at DESC LIMIT 50
                  """)
                  summary["recent_copies"] = [
                      {"politician": r[0], "symbol": r[1], "side": r[2], "qty": r[3], "copied_at": r[4]}
                      for r in cur.fetchall()
                  ]
              except sqlite3.Error as e:
                  summary["error"] = f"trades query failed: {e}"
              try:
                  cur.execute("SELECT COUNT(*) FROM open_positions")
                  summary["open_positions"] = cur.fetchone()[0]
              except sqlite3.Error:
                  summary["open_positions"] = None
              conn.close()
          else:
              summary["error"] = "state.db not present"
          with open("congress_summary.json", "w") as f:
              json.dump(summary, f)
          PY

      - name: Push congress summary to dashboard
        if: always()
        env:
          BOT_PUSH_TOKEN: ${{ secrets.BOT_PUSH_TOKEN }}
        run: |
          if [ -f congress_summary.json ]; then
            curl -fsS --max-time 10 \
              -X POST https://dash.fattieslearnscoding.com/api/bot-state \
              -H "Authorization: Bearer $BOT_PUSH_TOKEN" \
              -H "Content-Type: application/json" \
              -d "$(jq -n --slurpfile p congress_summary.json \
                         '{key: "bot:congress", payload: $p[0]}')" \
              || echo "Dashboard push for congress summary failed (non-fatal)"
          else
            echo "congress_summary.json not built — skipping dashboard push"
          fi
```

> If the `trades`/`open_positions` table names differ in the actual congress-copy schema, adjust the SQL — read `congress-copy/state.py` (or wherever the schema is defined) before committing.

- [ ] **Step 3: Verify the schema assumption**

```bash
grep -rn "CREATE TABLE" congress-copy/ | head -20
```

If table names differ, update the SQL in the step you just added.

- [ ] **Step 4: Validate YAML**

```bash
cat .github/workflows/congress-copy.yml | python -c "import sys, yaml; yaml.safe_load(sys.stdin); print('OK')"
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/congress-copy.yml
git commit -m "feat(workflows): push congress-copy summary to dashboard"
```

---

### Task 11: Document the BOT_PUSH_TOKEN secret + first-run backfill

**Files:**
- Create: `docs/BOT_PUSH_TOKEN_SETUP.md`

- [ ] **Step 1: Generate a token (do not commit the actual value)**

```bash
openssl rand -hex 32
```

Save the value in 1Password (or wherever you keep secrets). You'll paste it into both Vercel env vars AND the GitHub Actions secret in later tasks.

- [ ] **Step 2: Create the setup doc**

`docs/BOT_PUSH_TOKEN_SETUP.md`:

```markdown
# BOT_PUSH_TOKEN setup

The dashboard's `/api/bot-state` webhook is bearer-token-protected. The token must
be set in TWO places — both must hold the same value:

1. **GitHub Actions secret** — `tsronco/TradingBotTest-Claude` → Settings → Secrets and variables → Actions → New repository secret
   - Name: `BOT_PUSH_TOKEN`
   - Value: the 64-char hex string you generated with `openssl rand -hex 32`

2. **Vercel environment variable** — Vercel project `dashboard` → Settings → Environment Variables
   - Name: `BOT_PUSH_TOKEN`
   - Value: the same 64-char hex string
   - Apply to: Production, Preview, Development

Rotate the token by:
1. Generate a new value.
2. Update Vercel first (so the dashboard accepts the new token).
3. Then update the GitHub Actions secret.
4. Trigger a workflow run to verify (`gh workflow run tsla-monitor.yml`).

## First-run backfill

Until each workflow has run at least once after deploy, the dashboard's
KV will be empty for those keys. To prime it manually:

```bash
gh workflow run tsla-monitor.yml
gh workflow run tsla-monitor-aggressive.yml
gh workflow run congress-copy.yml
```

Wait ~1 minute, then check that the dashboard's home page shows fresh data.
```

- [ ] **Step 3: Commit**

```bash
git add docs/BOT_PUSH_TOKEN_SETUP.md
git commit -m "docs: BOT_PUSH_TOKEN setup + backfill procedure"
```

---

## Milestone 2 — Auth (TOTP + sessions)

### Task 12: TOTP verification helper (with tests)

**Files:**
- Create: `dashboard/api/_lib/totp.ts`
- Create: `dashboard/tests/lib/totp.test.ts`

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/lib/totp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import { verifyTotp } from '../../api/_lib/totp';

describe('verifyTotp', () => {
  const secret = authenticator.generateSecret();

  it('accepts a current valid code', () => {
    const code = authenticator.generate(secret);
    expect(verifyTotp(code, secret)).toBe(true);
  });

  it('rejects garbage', () => {
    expect(verifyTotp('000000', secret)).toBe(false);
    expect(verifyTotp('abcdef', secret)).toBe(false);
    expect(verifyTotp('', secret)).toBe(false);
  });

  it('rejects when the secret is missing', () => {
    expect(verifyTotp('123456', '')).toBe(false);
  });

  it('strips whitespace from input', () => {
    const code = authenticator.generate(secret);
    expect(verifyTotp(`  ${code} `, secret)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd dashboard
npm test -- tests/lib/totp.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `api/_lib/totp.ts`**

```ts
import { authenticator } from 'otplib';

// Default window of 1 = accept previous, current, or next 30s code (≈ ±30s clock skew tolerance).
authenticator.options = { window: 1 };

export function verifyTotp(code: string, secret: string): boolean {
  if (!secret) return false;
  const cleaned = (code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.verify({ token: cleaned, secret });
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- tests/lib/totp.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): TOTP verification helper with otplib"
```

---

### Task 13: Session cookie sign/verify helper (with tests)

**Files:**
- Create: `dashboard/api/_lib/session.ts`
- Create: `dashboard/tests/lib/session.test.ts`

The session cookie is a small JSON blob signed with HMAC-SHA256 using `SESSION_SECRET`. We chose roll-your-own (no `iron-session`) because the threat model is single-user and the implementation is < 50 lines.

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/lib/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeSession,
  decodeSession,
  serializeSessionCookie,
  type Session,
} from '../../api/_lib/session';

beforeEach(() => {
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

describe('encode/decode session', () => {
  const sample: Session = { sub: 'tim', loggedInAt: 1700000000 };

  it('round-trips a valid session', () => {
    const token = encodeSession(sample);
    const out = decodeSession(token);
    expect(out).toEqual(sample);
  });

  it('rejects a tampered token', () => {
    const token = encodeSession(sample);
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef`;
    expect(decodeSession(tampered)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(decodeSession('not-a-token')).toBeNull();
    expect(decodeSession('')).toBeNull();
  });

  it('rejects when SESSION_SECRET is missing', () => {
    process.env.SESSION_SECRET = '';
    const token = 'ignored.ignored';
    expect(decodeSession(token)).toBeNull();
  });
});

describe('serializeSessionCookie', () => {
  it('emits HttpOnly + Secure + SameSite=Strict', () => {
    const cookie = serializeSessionCookie('value-here', { secure: true });
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);   // 30 days
  });

  it('omits Secure flag in non-secure mode (for local dev)', () => {
    const cookie = serializeSessionCookie('v', { secure: false });
    expect(cookie).not.toMatch(/Secure/);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd dashboard
npm test -- tests/lib/session.test.ts
```

- [ ] **Step 3: Implement `api/_lib/session.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { serialize as cookieSerialize } from 'cookie';

export interface Session {
  sub: string;          // user identifier (always "tim" for this single-user app)
  loggedInAt: number;   // unix seconds
}

export const SESSION_COOKIE_NAME = 'dash_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;   // 30 days

function sign(input: string): string {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) throw new Error('SESSION_SECRET not set');
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function encodeSession(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString('base64url');
  const sig = sign(body);
  return `${body}.${sig}`;
}

export function decodeSession(token: string): Session | null {
  if (!token || typeof token !== 'string') return null;
  if (!process.env.SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
  } catch {
    return null;
  }
}

export function serializeSessionCookie(
  value: string,
  opts: { secure: boolean }
): string {
  return cookieSerialize(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  return cookieSerialize(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- tests/lib/session.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): HMAC-signed session cookie helper"
```

---

### Task 14: Auth-guard helper (used by every protected API route)

**Files:**
- Create: `dashboard/api/_lib/auth-guard.ts`

This wraps every protected serverless function so the auth check is one line at the top.

- [ ] **Step 1: Implement `api/_lib/auth-guard.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parse as parseCookie } from 'cookie';
import { decodeSession, SESSION_COOKIE_NAME, type Session } from './session';

export function getSession(req: VercelRequest): Session | null {
  const raw = req.headers.cookie ?? '';
  if (!raw) return null;
  const parsed = parseCookie(raw);
  const token = parsed[SESSION_COOKIE_NAME];
  if (!token) return null;
  return decodeSession(token);
}

export function requireAuth(req: VercelRequest, res: VercelResponse): Session | null {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return session;
}
```

- [ ] **Step 2: Commit (no test — exercised through API endpoint tests in later tasks)**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): auth-guard helper for protected routes"
```

---

### Task 15: `/api/auth/login` endpoint (with tests)

**Files:**
- Create: `dashboard/api/auth/login.ts`
- Create: `dashboard/tests/api/auth-login.test.ts`

- [ ] **Step 1: Write the failing tests**

`dashboard/tests/api/auth-login.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { authenticator } from 'otplib';
import handler from '../../api/auth/login';

const secret = authenticator.generateSecret();

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
  process.env.TOTP_SECRET = secret;
  process.env.SESSION_SECRET = 'a'.repeat(64);
});

function makeReqRes(body: any, method = 'POST') {
  const req: any = {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  };
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string | string[]>,
    setHeader(k: string, v: string | string[]) { this.headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: any) { this.body = p; return this; },
    end() { return this; },
  };
  return { req, res };
}

describe('POST /api/auth/login', () => {
  it('returns 405 on GET', async () => {
    const { req, res } = makeReqRes({}, 'GET');
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects wrong password', async () => {
    const { req, res } = makeReqRes({
      password: 'wrong',
      totp: authenticator.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('rejects wrong TOTP', async () => {
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: '000000',
    });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing fields', async () => {
    const { req, res } = makeReqRes({ password: 'correct-horse-battery-staple' });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('sets a session cookie on valid password + TOTP', async () => {
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: authenticator.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['Set-Cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toMatch(/dash_session=/);
    expect(String(setCookie)).toMatch(/HttpOnly/);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd dashboard
npm test -- tests/api/auth-login.test.ts
```

- [ ] **Step 3: Implement `api/auth/login.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyTotp } from '../_lib/totp';
import { encodeSession, serializeSessionCookie } from '../_lib/session';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { password, totp } = (req.body ?? {}) as {
    password?: string;
    totp?: string;
  };

  if (!password || !totp) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const expectedPassword = process.env.DASHBOARD_PASSWORD ?? '';
  const totpSecret = process.env.TOTP_SECRET ?? '';

  if (!expectedPassword || password !== expectedPassword) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!verifyTotp(totp, totpSecret)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = encodeSession({ sub: 'tim', loggedInAt: Math.floor(Date.now() / 1000) });
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', serializeSessionCookie(token, { secure: isProd }));
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npm test -- tests/api/auth-login.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): POST /api/auth/login with password + TOTP + session cookie"
```

---

### Task 16: `/api/auth/logout` and `/api/auth/session` endpoints

**Files:**
- Create: `dashboard/api/auth/logout.ts`
- Create: `dashboard/api/auth/session.ts`

- [ ] **Step 1: Implement `api/auth/logout.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearSessionCookie } from '../_lib/session';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', clearSessionCookie({ secure: isProd }));
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 2: Implement `api/auth/session.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSession } from '../_lib/auth-guard';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const session = getSession(req);
  if (!session) return res.status(200).json({ authenticated: false });
  return res.status(200).json({ authenticated: true, session });
}
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /api/auth/logout + /api/auth/session endpoints"
```

---

### Task 16.5: Rate-limit `/api/auth/login` via KV

**Files:**
- Create: `dashboard/api/_lib/rate-limit.ts`
- Modify: `dashboard/api/auth/login.ts`

KV-backed because Vercel functions are stateless across invocations — in-memory counters won't work.

- [ ] **Step 1: Create `api/_lib/rate-limit.ts`**

```ts
import { kv } from './kv';

const WINDOW_SECONDS = 60 * 15;   // 15 minutes
const MAX_FAILURES = 5;

function failKey(ip: string): string {
  return `auth:fail:${ip}`;
}

export async function isRateLimited(ip: string): Promise<boolean> {
  const count = await kv().get<number>(failKey(ip));
  return (count ?? 0) >= MAX_FAILURES;
}

export async function recordFailure(ip: string): Promise<void> {
  const key = failKey(ip);
  // Increment + reset TTL each failure → window slides on continued attempts.
  const next = ((await kv().get<number>(key)) ?? 0) + 1;
  await kv().set(key, next, { ex: WINDOW_SECONDS });
}

export async function clearFailures(ip: string): Promise<void> {
  await kv().del(failKey(ip));
}

export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  // Vercel forwards client IP via x-forwarded-for; first hop is the real client.
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  if (Array.isArray(xff)) return String(xff[0]).split(',')[0].trim();
  const real = headers['x-real-ip'];
  return typeof real === 'string' ? real : 'unknown';
}
```

- [ ] **Step 2: Modify `api/auth/login.ts` to call the rate-limiter**

Replace the existing handler with this version (additions marked with comments):

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyTotp } from '../_lib/totp';
import { encodeSession, serializeSessionCookie } from '../_lib/session';
import { isRateLimited, recordFailure, clearFailures, clientIp } from '../_lib/rate-limit';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const ip = clientIp(req.headers as any);

  // CHANGE: rate-limit check up front
  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const { password, totp } = (req.body ?? {}) as {
    password?: string;
    totp?: string;
  };

  if (!password || !totp) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const expectedPassword = process.env.DASHBOARD_PASSWORD ?? '';
  const totpSecret = process.env.TOTP_SECRET ?? '';

  if (!expectedPassword || password !== expectedPassword) {
    await recordFailure(ip);                                // CHANGE
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (!verifyTotp(totp, totpSecret)) {
    await recordFailure(ip);                                // CHANGE
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  await clearFailures(ip);                                  // CHANGE
  const token = encodeSession({ sub: 'tim', loggedInAt: Math.floor(Date.now() / 1000) });
  const isProd = process.env.VERCEL_ENV === 'production';
  res.setHeader('Set-Cookie', serializeSessionCookie(token, { secure: isProd }));
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 3: Update the existing tests so they mock the rate-limit functions**

Add this to the top of `dashboard/tests/api/auth-login.test.ts`, just below the imports:

```ts
import * as rateLimit from '../../api/_lib/rate-limit';

vi.spyOn(rateLimit, 'isRateLimited').mockResolvedValue(false);
vi.spyOn(rateLimit, 'recordFailure').mockResolvedValue();
vi.spyOn(rateLimit, 'clearFailures').mockResolvedValue();
```

- [ ] **Step 4: Add a new test for the rate-limit path**

In `dashboard/tests/api/auth-login.test.ts`, append:

```ts
import { authenticator as authForLast } from 'otplib';   // alias avoids re-import error if already imported

describe('rate limiting', () => {
  it('returns 429 when isRateLimited returns true', async () => {
    (rateLimit.isRateLimited as any).mockResolvedValueOnce(true);
    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: authForLast.generate(secret),
    });
    await handler(req, res);
    expect(res.statusCode).toBe(429);
  });
});
```

- [ ] **Step 5: Run tests — expect all to pass**

```bash
cd dashboard
npm test -- tests/api/auth-login.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): KV-backed rate limit on /api/auth/login (5 fails / 15 min)"
```

---

### Task 16.7: Backup codes for lost-phone recovery

**Files:**
- Create: `dashboard/api/_lib/backup-codes.ts`
- Modify: `dashboard/api/auth/login.ts`

Backup codes are 12-character base32 strings (e.g. `K7MR-Q9XV-3LD2`). 8 of them are generated at setup, hashed with SHA-256, and the hashes are stored in `BACKUP_CODES_HASHED` env var (comma-separated). When one is used, we record the *hash* in KV so it can never be used twice.

- [ ] **Step 1: Create `api/_lib/backup-codes.ts`**

```ts
import { createHash } from 'node:crypto';
import { kv } from './kv';

function normalize(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hash(code: string): string {
  return createHash('sha256').update(normalize(code)).digest('hex');
}

const USED_KEY = 'auth:used-backup-codes';

/**
 * Returns true iff the input matches an unused backup code.
 * On match, the code is marked consumed atomically (idempotent if called twice).
 */
export async function consumeBackupCodeIfValid(input: string): Promise<boolean> {
  if (!input) return false;
  const candidate = hash(input);
  const allowed = (process.env.BACKUP_CODES_HASHED ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(candidate)) return false;
  const used = ((await kv().get<string[]>(USED_KEY)) ?? []);
  if (used.includes(candidate)) return false;
  used.push(candidate);
  await kv().set(USED_KEY, used);
  return true;
}

/** True if the input *looks* like a backup code (not a 6-digit TOTP). */
export function looksLikeBackupCode(input: string): boolean {
  const cleaned = normalize(input);
  return cleaned.length >= 10 && /^[A-Z0-9]+$/.test(cleaned);
}

/** Used at setup time only — generate a fresh code and its hash. Logged once, never stored plaintext. */
export function generateBackupCode(): { code: string; hash: string } {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // omit confusing 0/O/1/I
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
    if (i === 3 || i === 7) code += '-';
  }
  return { code, hash: hash(code) };
}
```

- [ ] **Step 2: Modify `api/auth/login.ts` to accept backup codes as TOTP alternative**

Replace the TOTP-check block in the handler with:

```ts
  // existing:
  if (!expectedPassword || password !== expectedPassword) {
    await recordFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  // CHANGE: accept either a TOTP code OR a backup code
  let secondFactorOk = false;
  if (looksLikeBackupCode(totp)) {
    secondFactorOk = await consumeBackupCodeIfValid(totp);
  } else {
    secondFactorOk = verifyTotp(totp, totpSecret);
  }
  if (!secondFactorOk) {
    await recordFailure(ip);
    return res.status(401).json({ error: 'invalid_credentials' });
  }
```

Add the new imports at the top:

```ts
import { looksLikeBackupCode, consumeBackupCodeIfValid } from '../_lib/backup-codes';
```

- [ ] **Step 3: Add `BACKUP_CODES_HASHED` to `.env.example`**

In `dashboard/.env.example`, replace the line:
```
BACKUP_CODES=hashed-comma-separated-list-of-8-codes
```
with:
```
BACKUP_CODES_HASHED=hash1,hash2,hash3,hash4,hash5,hash6,hash7,hash8
```

- [ ] **Step 4: Add a test for the backup-code happy path**

In `dashboard/tests/api/auth-login.test.ts`, append:

```ts
import { generateBackupCode } from '../../api/_lib/backup-codes';
import * as kvModule from '../../api/_lib/kv';

describe('backup code login', () => {
  it('accepts an unused backup code in place of TOTP', async () => {
    const { code, hash } = generateBackupCode();
    process.env.BACKUP_CODES_HASHED = hash;

    const kvGet = vi.fn().mockResolvedValue(null);
    const kvSet = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(kvModule, 'kv').mockReturnValue({ get: kvGet, set: kvSet, del: vi.fn() } as any);

    const { req, res } = makeReqRes({
      password: 'correct-horse-battery-staple',
      totp: code,
    });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 5: Run tests — expect all to pass**

```bash
cd dashboard
npm test -- tests/api/auth-login.test.ts
```

- [ ] **Step 6: Add a one-shot CLI script for generating backup codes at setup time**

Create `dashboard/scripts/generate-backup-codes.ts`:

```ts
import { generateBackupCode } from '../api/_lib/backup-codes';

console.log('=== Backup codes — store these somewhere safe ===');
console.log('Each code can be used once in place of your TOTP.\n');

const hashes: string[] = [];
for (let i = 1; i <= 8; i++) {
  const { code, hash } = generateBackupCode();
  console.log(`${i}. ${code}`);
  hashes.push(hash);
}

console.log('\n=== Add this to Vercel env vars ===');
console.log(`BACKUP_CODES_HASHED=${hashes.join(',')}`);
```

Document running it once at setup in `DEPLOY.md` (we'll integrate into Task 38 below).

- [ ] **Step 7: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): backup codes for lost-phone recovery + setup script"
```

---

### Task 17: Login page UI

**Files:**
- Create: `dashboard/src/routes/Login.tsx`

- [ ] **Step 1: Implement `src/routes/Login.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, totp }),
      });
      if (!res.ok) {
        setError('Invalid password or TOTP code.');
        return;
      }
      const next = (loc.state as any)?.from ?? '/';
      nav(next, { replace: true });
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <form
        onSubmit={onSubmit}
        className="bg-panel border border-border rounded-xl p-8 w-full max-w-sm"
      >
        <h1 className="text-text-strong text-xl font-bold mb-1">Sign in</h1>
        <p className="text-muted text-xs mb-6">Trading Dashboard</p>

        <label className="block text-muted text-xs mb-1">Password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-text mb-4 focus:outline-none focus:border-accent"
        />

        <label className="block text-muted text-xs mb-1">6-digit code</label>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoComplete="one-time-code"
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="w-full bg-bg border border-border rounded-md px-3 py-2 text-text mb-4 focus:outline-none focus:border-accent tracking-widest"
        />

        {error && (
          <div className="text-red text-xs mb-3">{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || password.length === 0 || totp.length !== 6}
          className="w-full bg-accent/90 hover:bg-accent text-bg font-semibold rounded-md py-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): login page UI"
```

---

### Task 18: ProtectedRoute + useAuth hook + router wiring

**Files:**
- Create: `dashboard/src/hooks/useAuth.ts`
- Create: `dashboard/src/components/auth/ProtectedRoute.tsx`
- Create: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Create `src/lib/api.ts` — the client-side fetch wrapper**

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
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
    throw new ApiError(res.status, body?.error ?? `request_failed_${res.status}`);
  }
  return (await res.json()) as T;
}
```

- [ ] **Step 2: Create `src/hooks/useAuth.ts`**

```ts
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
```

- [ ] **Step 3: Create `src/components/auth/ProtectedRoute.tsx`**

```tsx
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
```

- [ ] **Step 4: Replace `src/App.tsx` with the router**

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Login from './routes/Login';
import Home from './routes/Home';
import Positions from './routes/Positions';
import Orders from './routes/Orders';
import Lookup from './routes/Lookup';
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
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 5: Stub the four protected routes so the build passes**

Create each as a placeholder that we'll fill in later tasks.

`src/routes/Home.tsx`:
```tsx
export default function Home() { return <div className="p-6">Home (TBD)</div>; }
```
`src/routes/Positions.tsx`:
```tsx
export default function Positions() { return <div className="p-6">Positions (TBD)</div>; }
```
`src/routes/Orders.tsx`:
```tsx
export default function Orders() { return <div className="p-6">Orders (TBD)</div>; }
```
`src/routes/Lookup.tsx`:
```tsx
import { useParams } from 'react-router-dom';
export default function Lookup() {
  const { symbol } = useParams();
  return <div className="p-6">Lookup: {symbol} (TBD)</div>;
}
```

> The "(TBD)" placeholders are expected — they'll be replaced by Tasks 30 (Home), 31 (Positions), 32 (Orders), and 37 (Lookup). They are *not* a plan placeholder. Each is wired to an actual route.

- [ ] **Step 6: Build to verify**

```bash
cd dashboard
npm run build
```

Expected: build succeeds with no TS errors.

- [ ] **Step 7: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): router, query provider, protected routes, route stubs"
```

---

### Task 19: AppShell with sidebar layout

**Files:**
- Create: `dashboard/src/components/layout/AppShell.tsx`
- Create: `dashboard/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Create `src/components/layout/Sidebar.tsx`**

```tsx
import { NavLink } from 'react-router-dom';
import { Home, Briefcase, FileText, Search, LogOut } from 'lucide-react';
import { useLogout } from '../../hooks/useAuth';

const navItems = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/positions', label: 'Positions', icon: Briefcase },
  { to: '/orders', label: 'Orders', icon: FileText },
];

export default function Sidebar() {
  const logout = useLogout();
  return (
    <aside className="w-48 bg-panel border-r border-border flex flex-col">
      <div className="p-4 border-b border-border">
        <div className="text-text-strong font-bold">TIM DASH</div>
        <div className="text-muted text-[10px] uppercase tracking-wider">
          Trading
        </div>
      </div>

      <nav className="flex-1 p-2">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                isActive
                  ? 'bg-panel-2 text-text-strong'
                  : 'text-muted hover:text-text hover:bg-panel-2/50'
              }`
            }
          >
            <item.icon size={14} />
            {item.label}
          </NavLink>
        ))}

        <NavLink
          to="/lookup/SPY"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
              isActive
                ? 'bg-panel-2 text-text-strong'
                : 'text-muted hover:text-text hover:bg-panel-2/50'
            }`
          }
        >
          <Search size={14} />
          Lookup
        </NavLink>
      </nav>

      <div className="p-2 border-t border-border">
        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSuccess: () => (window.location.href = '/login') })}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted hover:text-text hover:bg-panel-2/50"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Create `src/components/layout/AppShell.tsx`**

```tsx
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function AppShell() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd dashboard && npm run build
```

- [ ] **Step 4: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): app shell with sidebar nav + sign-out"
```

---

## Milestone 3 — Alpaca proxy endpoints

### Task 20: Server-side Alpaca client wrapper

**Files:**
- Create: `dashboard/api/_lib/alpaca.ts`

The wrapper picks credentials based on a `mode` query string param (`conservative` | `aggressive`). Built once, used by every Alpaca proxy endpoint.

- [ ] **Step 1: Implement `api/_lib/alpaca.ts`**

```ts
import { createClient } from '@alpacahq/typescript-sdk';

export type Mode = 'conservative' | 'aggressive';

export function isMode(s: unknown): s is Mode {
  return s === 'conservative' || s === 'aggressive';
}

export function modeFromQuery(q: unknown): Mode {
  const v = Array.isArray(q) ? q[0] : q;
  return isMode(v) ? v : 'conservative';
}

export function alpacaFor(mode: Mode) {
  const key = mode === 'conservative'
    ? process.env.ALPACA_API_KEY
    : process.env.ALPACA_AGG_API_KEY;
  const secret = mode === 'conservative'
    ? process.env.ALPACA_API_SECRET
    : process.env.ALPACA_AGG_API_SECRET;
  if (!key || !secret) {
    throw new Error(`alpaca creds missing for mode=${mode}`);
  }
  return createClient({ key, secret });
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): server-side Alpaca client wrapper with mode switching"
```

---

### Task 21: `/api/alpaca/account` endpoint

**Files:**
- Create: `dashboard/api/alpaca/account.ts`

- [ ] **Step 1: Implement**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  try {
    const account = await alpacaFor(mode).getAccount();
    return res.status(200).json({ mode, account });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/account?mode=..."
```

---

### Task 22: `/api/alpaca/positions` endpoint

**Files:**
- Create: `dashboard/api/alpaca/positions.ts`

- [ ] **Step 1: Implement**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  try {
    const positions = await alpacaFor(mode).getPositions();
    return res.status(200).json({ mode, positions });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/positions?mode=..."
```

---

### Task 23: `/api/alpaca/orders` endpoint

**Files:**
- Create: `dashboard/api/alpaca/orders.ts`

- [ ] **Step 1: Implement**

Supports `?status=open|closed|all` (default `all`) and `?mode=...`.

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const statusRaw = (Array.isArray(req.query.status) ? req.query.status[0] : req.query.status) ?? 'all';
  const status = ['open', 'closed', 'all'].includes(statusRaw as string)
    ? (statusRaw as 'open' | 'closed' | 'all')
    : 'all';
  try {
    const orders = await alpacaFor(mode).getOrders({ status, limit: 100, direction: 'desc' });
    return res.status(200).json({ mode, status, orders });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/orders?mode=...&status=..."
```

---

### Task 24: `/api/alpaca/quote` endpoint

**Files:**
- Create: `dashboard/api/alpaca/quote.ts`

- [ ] **Step 1: Implement**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const snap = await alpacaFor(mode).getStocksSnapshots({ symbols: symbol });
    return res.status(200).json({ mode, symbol, snapshot: snap });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/quote?symbol=..."
```

---

### Task 25: `/api/alpaca/chain` endpoint (options chain with Greeks)

**Files:**
- Create: `dashboard/api/alpaca/chain.ts`

The chain is two Alpaca calls: `getOptionsContracts` for the contract list, then `getOptionsSnapshots` for the Greeks. We do them server-side and return a merged shape.

- [ ] **Step 1: Implement**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const expiration = req.query.expiration ? String(req.query.expiration) : undefined;
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const client = alpacaFor(mode);
    const contracts = await client.getOptionsContracts({
      underlying_symbols: symbol,
      ...(expiration ? { expiration_date: expiration } : {}),
      limit: 200,
    });
    const ids = (contracts as any).option_contracts?.map((c: any) => c.symbol) ?? [];
    if (ids.length === 0) {
      return res.status(200).json({ mode, symbol, expiration, contracts: [] });
    }
    // Snapshots gives us bid/ask + Greeks (delta, gamma, theta, vega) + IV.
    const snapshots = await client.getOptionsSnapshots({ symbols: ids.join(',') });
    return res.status(200).json({
      mode,
      symbol,
      expiration,
      contracts: (contracts as any).option_contracts ?? [],
      snapshots,
    });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/chain returns contracts + snapshots (greeks)"
```

---

### Task 26: `/api/alpaca/news` and `/api/alpaca/bars` endpoints

**Files:**
- Create: `dashboard/api/alpaca/news.ts`
- Create: `dashboard/api/alpaca/bars.ts`

- [ ] **Step 1: Implement `api/alpaca/news.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const news = await alpacaFor(mode).getNews({ symbols: symbol, limit });
    return res.status(200).json({ symbol, news });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 2: Implement `api/alpaca/bars.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { alpacaFor, modeFromQuery } from '../_lib/alpaca';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const mode = modeFromQuery(req.query.mode);
  const symbol = String(req.query.symbol ?? '').toUpperCase();
  const timeframe = String(req.query.timeframe ?? '1Day');
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 90));
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: 'invalid_symbol' });
  }
  try {
    const bars = await alpacaFor(mode).getStocksBars({ symbol, timeframe, limit });
    return res.status(200).json({ symbol, timeframe, bars });
  } catch (e) {
    return res.status(502).json({ error: 'alpaca_request_failed', detail: String(e) });
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): GET /api/alpaca/news + /api/alpaca/bars"
```

---

### Task 27: `/api/kv/bot-state` read endpoint + `/api/kv/watchlist` read+write endpoint

**Files:**
- Create: `dashboard/api/kv/bot-state.ts`
- Create: `dashboard/api/kv/watchlist.ts`

- [ ] **Step 1: Implement `api/kv/bot-state.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { getJson } from '../_lib/kv';
import { isAllowedBotStateKey, lastUpdateKey } from '../_lib/kv-keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const key = String(req.query.key ?? '');
  if (!isAllowedBotStateKey(key)) {
    return res.status(400).json({ error: 'invalid_key' });
  }
  const [payload, lastUpdate] = await Promise.all([
    getJson(key),
    getJson<string>(lastUpdateKey(key)),
  ]);
  return res.status(200).json({ key, payload, lastUpdate });
}
```

- [ ] **Step 2: Implement `api/kv/watchlist.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../_lib/auth-guard';
import { getJson, setJson } from '../_lib/kv';
import { KV_KEYS } from '../_lib/kv-keys';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const list = (await getJson<string[]>(KV_KEYS.watchlist)) ?? [];
    return res.status(200).json({ watchlist: list });
  }

  if (req.method === 'POST') {
    const symbol = String((req.body as any)?.symbol ?? '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
      return res.status(400).json({ error: 'invalid_symbol' });
    }
    const list = new Set((await getJson<string[]>(KV_KEYS.watchlist)) ?? []);
    list.add(symbol);
    const next = [...list].sort();
    await setJson(KV_KEYS.watchlist, next);
    return res.status(200).json({ watchlist: next });
  }

  if (req.method === 'DELETE') {
    const symbol = String((req.body as any)?.symbol ?? '').toUpperCase();
    const list = ((await getJson<string[]>(KV_KEYS.watchlist)) ?? []).filter((s) => s !== symbol);
    await setJson(KV_KEYS.watchlist, list);
    return res.status(200).json({ watchlist: list });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).end();
}
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /api/kv/bot-state (read) + /api/kv/watchlist (CRUD)"
```

---

### Task 28: yfinance Python edge function for `/api/fundamentals`

**Files:**
- Create: `dashboard/api/fundamentals.py`
- Create: `dashboard/requirements.txt`

- [ ] **Step 1: Create `requirements.txt`**

```
yfinance==0.2.50
```

- [ ] **Step 2: Implement `api/fundamentals.py`**

Note: Vercel Python functions don't have access to the session cookie verification we wrote in TS. For Phase 1, we wrap this with a header-based shared-secret check (`X-Internal-Auth`) and have the *frontend* go through a TS proxy. To keep it simple here, we apply the same `BOT_PUSH_TOKEN` style: require any signed-in user to call via a TS proxy. **For now**, this Python function is *unauthenticated* but rate-limit-safe and only returns public data — we'll proxy-protect it via vercel.json in Step 4.

```python
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import yfinance as yf

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            symbol = (qs.get('symbol') or [''])[0].upper().strip()
            if not symbol or not symbol.replace('.', '').replace('-', '').isalnum():
                self._respond(400, {'error': 'invalid_symbol'})
                return
            t = yf.Ticker(symbol)
            info = t.info or {}
            # Earnings dates: returns a DataFrame; convert to list of dicts.
            try:
                edf = t.get_earnings_dates(limit=12)
                earnings = [
                    {
                        'date': str(idx),
                        'eps_estimate': (None if r.get('EPS Estimate') is None else float(r['EPS Estimate'])),
                        'reported_eps': (None if r.get('Reported EPS') is None else float(r['Reported EPS'])),
                        'surprise_pct': (None if r.get('Surprise(%)') is None else float(r['Surprise(%)'])),
                    }
                    for idx, r in (edf.iterrows() if edf is not None else [])
                ]
            except Exception as e:  # yfinance can throw on missing data
                earnings = []
            payload = {
                'symbol': symbol,
                'fundamentals': {
                    'market_cap': info.get('marketCap'),
                    'pe_ratio': info.get('trailingPE'),
                    'sector': info.get('sector'),
                    'industry': info.get('industry'),
                    'fifty_two_week_low': info.get('fiftyTwoWeekLow'),
                    'fifty_two_week_high': info.get('fiftyTwoWeekHigh'),
                    'next_earnings_date': info.get('earningsTimestamp'),
                },
                'earnings': earnings,
            }
            self._respond(200, payload)
        except Exception as e:
            self._respond(502, {'error': 'fundamentals_failed', 'detail': str(e)})

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 's-maxage=3600, stale-while-revalidate')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode('utf-8'))
```

- [ ] **Step 3: Verify the dependency installs locally**

```bash
cd dashboard
python -m pip install -r requirements.txt
```

(Vercel will install this automatically on deploy via `requirements.txt`.)

- [ ] **Step 4: Wrap the Python endpoint with auth via the existing TS proxy pattern**

To keep the Python function private (only callable from a logged-in session), add a TS proxy at `api/fundamentals-proxy.ts` that checks auth and forwards to the Python function via internal Vercel routing. Create `dashboard/api/fundamentals-proxy.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from './_lib/auth-guard';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!requireAuth(req, res)) return;
  const symbol = String(req.query.symbol ?? '');
  // Vercel routes /api/fundamentals.py as /api/fundamentals — call it server-to-server.
  const url = `https://${req.headers.host}/api/fundamentals?symbol=${encodeURIComponent(symbol)}`;
  const resp = await fetch(url);
  res.setHeader('Content-Type', 'application/json');
  res.status(resp.status);
  res.send(await resp.text());
}
```

The **frontend always calls `/api/fundamentals-proxy?symbol=...`**, never `/api/fundamentals` directly. The Python function is technically reachable but returns only public Yahoo data — the proxy gates the user-visible interface.

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): yfinance python edge function + auth-checked TS proxy"
```

---

## Milestone 4 — Read-only pages

### Task 29: Format helpers + Account components

**Files:**
- Create: `dashboard/src/lib/format.ts`
- Create: `dashboard/src/components/account/AccountCard.tsx`
- Create: `dashboard/src/components/account/AccountSelector.tsx`
- Create: `dashboard/src/hooks/useAccount.ts`

- [ ] **Step 1: Create `src/lib/format.ts`**

```ts
export function fmtUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = opts.sign && n > 0 ? '+' : '';
  return `${sign}${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || Number.isNaN(n)) return '—';
  const sign = opts.sign && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}
```

- [ ] **Step 2: Create `src/hooks/useAccount.ts` (selected-account state, persisted to localStorage)**

```ts
import { useEffect, useState } from 'react';

export type AccountMode = 'conservative' | 'aggressive' | 'both';
const KEY = 'dash:selectedAccount';

export function useAccount(): [AccountMode, (m: AccountMode) => void] {
  const [mode, setMode] = useState<AccountMode>(() => {
    if (typeof window === 'undefined') return 'both';
    return ((localStorage.getItem(KEY) as AccountMode) ?? 'both');
  });
  useEffect(() => { localStorage.setItem(KEY, mode); }, [mode]);
  return [mode, setMode];
}
```

- [ ] **Step 3: Create `src/components/account/AccountSelector.tsx`**

```tsx
import { useAccount, type AccountMode } from '../../hooks/useAccount';

const opts: { value: AccountMode; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'conservative', label: 'Conservative' },
  { value: 'aggressive', label: 'Aggressive' },
];

export default function AccountSelector() {
  const [mode, setMode] = useAccount();
  return (
    <div className="inline-flex bg-panel border border-border rounded-md overflow-hidden text-xs">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => setMode(o.value)}
          className={`px-3 py-1.5 ${
            mode === o.value
              ? 'bg-panel-2 text-text-strong'
              : 'text-muted hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `src/components/account/AccountCard.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';

export default function AccountCard({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['account', mode],
    queryFn: () => api<{ account: any }>(`/api/alpaca/account?mode=${mode}`),
  });

  if (isLoading) return <div className="bg-panel border border-border rounded-xl p-5 text-muted">Loading {label}…</div>;
  if (error || !data) return <div className="bg-panel border border-red rounded-xl p-5 text-red">Failed to load {label}</div>;

  const a = data.account;
  const equity = Number(a.equity);
  const lastEquity = Number(a.last_equity);
  const dayChange = equity - lastEquity;
  const dayChangePct = lastEquity ? (dayChange / lastEquity) * 100 : 0;
  const dayClass = dayChange >= 0 ? 'text-green' : 'text-red';

  return (
    <div className="bg-panel border border-border rounded-xl p-5">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-2">{label}</div>
      <div className="text-text-strong text-2xl font-bold">{fmtUsd(equity)}</div>
      <div className={`text-sm ${dayClass}`}>
        {fmtUsd(dayChange, { sign: true })} ({fmtPct(dayChangePct, { sign: true })}) today
      </div>
      <div className="grid grid-cols-2 gap-y-1 mt-4 text-xs">
        <span className="text-muted">Buying power</span>
        <span className="text-text text-right">{fmtUsd(Number(a.buying_power))}</span>
        <span className="text-muted">Cash</span>
        <span className="text-text text-right">{fmtUsd(Number(a.cash))}</span>
        <span className="text-muted">Long mkt value</span>
        <span className="text-text text-right">{fmtUsd(Number(a.long_market_value))}</span>
        <span className="text-muted">Short mkt value</span>
        <span className="text-text text-right">{fmtUsd(Number(a.short_market_value))}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): account selector + account card + format helpers"
```

---

### Task 30: Home page (dual-account snapshot)

**Files:**
- Modify: `dashboard/src/routes/Home.tsx`

- [ ] **Step 1: Replace `src/routes/Home.tsx`**

```tsx
import AccountCard from '../components/account/AccountCard';

export default function Home() {
  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Today</h1>
        <span className="text-muted text-xs">
          {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <AccountCard mode="conservative" label="Conservative" />
        <AccountCard mode="aggressive" label="Aggressive" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd dashboard && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): home page with both accounts side-by-side"
```

---

### Task 31: Positions page

**Files:**
- Modify: `dashboard/src/routes/Positions.tsx`

- [ ] **Step 1: Replace `src/routes/Positions.tsx`**

Shows stocks + options w/ Greeks. Filters by AccountSelector.

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../lib/format';
import AccountSelector from '../components/account/AccountSelector';
import { useAccount } from '../hooks/useAccount';

interface Position {
  symbol: string;
  asset_class: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

function PositionsTable({ mode, label }: { mode: 'conservative' | 'aggressive'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['positions', mode],
    queryFn: () => api<{ positions: Position[] }>(`/api/alpaca/positions?mode=${mode}`),
  });

  if (isLoading) return <div className="text-muted text-sm">Loading {label}…</div>;
  if (error) return <div className="text-red text-sm">Failed to load {label}</div>;
  const positions = data?.positions ?? [];

  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="text-muted text-[10px] uppercase tracking-wider">{label}</div>
        <div className="text-muted text-xs">{positions.length} positions</div>
      </div>
      {positions.length === 0 ? (
        <div className="p-6 text-muted text-sm">No open positions.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted uppercase tracking-wider text-[10px]">
            <tr>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Avg cost</th>
              <th className="text-right px-4 py-2">Current</th>
              <th className="text-right px-4 py-2">Mkt value</th>
              <th className="text-right px-4 py-2">Unrealized P&L</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const pl = Number(p.unrealized_pl);
              const plpc = Number(p.unrealized_plpc) * 100;
              const klass = pl >= 0 ? 'text-green' : 'text-red';
              return (
                <tr key={p.symbol} className="border-t border-border">
                  <td className="px-4 py-2 text-text">{p.symbol}{p.asset_class === 'us_option' ? ' 📑' : ''}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(Number(p.qty))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.avg_entry_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.current_price))}</td>
                  <td className="px-4 py-2 text-right">{fmtUsd(Number(p.market_value))}</td>
                  <td className={`px-4 py-2 text-right ${klass}`}>
                    {fmtUsd(pl, { sign: true })} ({fmtPct(plpc, { sign: true })})
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Positions() {
  const [mode] = useAccount();
  const showCons = mode === 'both' || mode === 'conservative';
  const showAgg = mode === 'both' || mode === 'aggressive';

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Positions</h1>
        <AccountSelector />
      </div>
      {showCons && <PositionsTable mode="conservative" label="Conservative" />}
      {showAgg && <PositionsTable mode="aggressive" label="Aggressive" />}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /positions page with account filter + per-mode tables"
```

---

### Task 32: Orders page (read-only)

**Files:**
- Modify: `dashboard/src/routes/Orders.tsx`

- [ ] **Step 1: Replace `src/routes/Orders.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtUsd, fmtNum } from '../lib/format';
import AccountSelector from '../components/account/AccountSelector';
import { useAccount } from '../hooks/useAccount';

interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: string;
  filled_qty: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  submitted_at: string;
  filled_at: string | null;
  filled_avg_price: string | null;
}

function OrdersTable({ mode, status, label }: { mode: 'conservative' | 'aggressive'; status: 'open' | 'closed'; label: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['orders', mode, status],
    queryFn: () => api<{ orders: Order[] }>(`/api/alpaca/orders?mode=${mode}&status=${status}`),
  });
  if (isLoading) return <div className="text-muted text-sm">Loading {label}…</div>;
  if (error) return <div className="text-red text-sm">Failed to load {label}</div>;
  const orders = data?.orders ?? [];

  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="text-muted text-[10px] uppercase tracking-wider">{label}</div>
        <div className="text-muted text-xs">{orders.length} orders</div>
      </div>
      {orders.length === 0 ? (
        <div className="p-6 text-muted text-sm">None.</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-muted uppercase tracking-wider text-[10px]">
            <tr>
              <th className="text-left px-4 py-2">Submitted</th>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-left px-4 py-2">Side</th>
              <th className="text-left px-4 py-2">Type</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Filled</th>
              <th className="text-right px-4 py-2">Price</th>
              <th className="text-left px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-border">
                <td className="px-4 py-2 text-muted">{new Date(o.submitted_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-text">{o.symbol}</td>
                <td className="px-4 py-2">{o.side}</td>
                <td className="px-4 py-2">{o.type}</td>
                <td className="px-4 py-2 text-right">{fmtNum(Number(o.qty))}</td>
                <td className="px-4 py-2 text-right">{fmtNum(Number(o.filled_qty))}</td>
                <td className="px-4 py-2 text-right">
                  {o.filled_avg_price
                    ? fmtUsd(Number(o.filled_avg_price))
                    : o.limit_price
                    ? `lim ${fmtUsd(Number(o.limit_price))}`
                    : o.stop_price
                    ? `stp ${fmtUsd(Number(o.stop_price))}`
                    : '—'}
                </td>
                <td className="px-4 py-2 text-muted">{o.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Orders() {
  const [mode] = useAccount();
  const sides = mode === 'both' ? ['conservative', 'aggressive'] : [mode];
  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-baseline justify-between mb-6">
        <h1 className="text-text-strong text-2xl font-bold">Orders</h1>
        <AccountSelector />
      </div>
      <h2 className="text-text-strong font-semibold mb-3">Open</h2>
      {sides.map((m) => <OrdersTable key={`open-${m}`} mode={m as any} status="open" label={m} />)}
      <h2 className="text-text-strong font-semibold mb-3 mt-6">Filled today</h2>
      {sides.map((m) => <OrdersTable key={`closed-${m}`} mode={m as any} status="closed" label={m} />)}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /orders page with open + filled tables, account-filterable"
```

---

## Milestone 5 — Lookup page

### Task 33: TradingView chart component

**Files:**
- Create: `dashboard/src/components/lookup/TradingViewChart.tsx`

The Advanced Chart widget is loaded from `https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js`. We mount it as a script that targets a div by id.

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef } from 'react';

export default function TradingViewChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';

    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      hide_top_toolbar: false,
      hide_legend: false,
      withdateranges: true,
      allow_symbol_change: false,
      details: false,
      studies: [],
    });
    container.appendChild(script);
  }, [symbol]);

  return <div ref={containerRef} className="w-full h-[280px]" />;
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): TradingView Advanced Chart widget component"
```

---

### Task 34: Quote panel + Position-context panel

**Files:**
- Create: `dashboard/src/components/lookup/QuotePanel.tsx`
- Create: `dashboard/src/components/lookup/PositionContextPanel.tsx`

- [ ] **Step 1: Implement `QuotePanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

export default function QuotePanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['quote', symbol],
    queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`),
    refetchInterval: 15_000,
  });
  if (isLoading || !data) return <div className="text-muted text-sm">Loading quote…</div>;

  const snap = data.snapshot?.[symbol] ?? data.snapshot;
  const last = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  const prev = snap?.prevDailyBar?.c;
  const change = last && prev ? last - prev : null;
  const changePct = change && prev ? (change / prev) * 100 : null;
  const klass = change && change > 0 ? 'text-green' : 'text-red';

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="text-text-strong text-2xl font-bold">{fmtUsd(last)}</span>
        {change !== null && (
          <span className={`text-sm ${klass}`}>
            {fmtUsd(change, { sign: true })} ({fmtPct(changePct, { sign: true })})
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-y-1 mt-3 text-xs">
        <dt className="text-muted">Bid / Ask</dt>
        <dd className="text-text text-right">
          {snap?.latestQuote ? `${snap.latestQuote.bp} / ${snap.latestQuote.ap}` : '—'}
        </dd>
        <dt className="text-muted">Day range</dt>
        <dd className="text-text text-right">
          {snap?.dailyBar ? `${snap.dailyBar.l} — ${snap.dailyBar.h}` : '—'}
        </dd>
        <dt className="text-muted">Volume</dt>
        <dd className="text-text text-right">{fmtNum(snap?.dailyBar?.v)}</dd>
      </dl>
    </div>
  );
}
```

- [ ] **Step 2: Implement `PositionContextPanel.tsx`**

```tsx
import { useQueries } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct, fmtNum } from '../../lib/format';

export default function PositionContextPanel({ symbol }: { symbol: string }) {
  const queries = useQueries({
    queries: (['conservative', 'aggressive'] as const).map((mode) => ({
      queryKey: ['positions', mode],
      queryFn: () => api<{ positions: any[] }>(`/api/alpaca/positions?mode=${mode}`),
    })),
  });

  const matches: { mode: string; pos: any }[] = [];
  queries.forEach((q, i) => {
    const mode = (['conservative', 'aggressive'] as const)[i];
    const pos = q.data?.positions?.find((p: any) => p.symbol === symbol);
    if (pos) matches.push({ mode, pos });
  });

  if (queries.some((q) => q.isLoading)) return <div className="text-muted text-xs">Checking…</div>;
  if (matches.length === 0) {
    return <div className="text-muted text-xs">You don't hold {symbol}.</div>;
  }

  return (
    <div>
      {matches.map(({ mode, pos }) => {
        const pl = Number(pos.unrealized_pl);
        const plpc = Number(pos.unrealized_plpc) * 100;
        return (
          <div key={mode} className="mb-3 last:mb-0">
            <div className="text-muted text-[10px] uppercase">{mode}</div>
            <div className="grid grid-cols-2 gap-y-1 text-xs mt-1">
              <span className="text-muted">Qty</span>
              <span className="text-text text-right">{fmtNum(Number(pos.qty))}</span>
              <span className="text-muted">Avg cost</span>
              <span className="text-text text-right">{fmtUsd(Number(pos.avg_entry_price))}</span>
              <span className="text-muted">Unrealized P&L</span>
              <span className={`text-right ${pl >= 0 ? 'text-green' : 'text-red'}`}>
                {fmtUsd(pl, { sign: true })} ({fmtPct(plpc, { sign: true })})
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): QuotePanel + PositionContextPanel for /lookup"
```

---

### Task 35: Options chain panel (with all 5 Greeks)

**Files:**
- Create: `dashboard/src/components/lookup/OptionsChain.tsx`

Five Greeks: Δ (delta), Γ (gamma), Θ (theta), ν (vega), and IV (implied vol). The Alpaca options-snapshot returns these. We render them in a single table with the most-relevant strikes near at-the-money.

- [ ] **Step 1: Implement**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useState } from 'react';

interface ChainResponse {
  contracts: Array<{
    symbol: string;
    underlying_symbol: string;
    expiration_date: string;
    strike_price: string;
    type: 'call' | 'put';
  }>;
  snapshots: Record<string, {
    latestQuote?: { ap: number; bp: number };
    greeks?: { delta: number; gamma: number; theta: number; vega: number };
    impliedVolatility?: number;
    openInterest?: number;
    dailyBar?: { v: number };
  }>;
}

export default function OptionsChain({ symbol }: { symbol: string }) {
  const [showAllGreeks, setShowAllGreeks] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['chain', symbol],
    queryFn: () => api<ChainResponse>(`/api/alpaca/chain?symbol=${symbol}`),
  });

  if (isLoading || !data) return <div className="text-muted text-sm">Loading options chain…</div>;
  if (data.contracts.length === 0) {
    return <div className="text-muted text-sm">No option contracts available for {symbol}.</div>;
  }

  // Group by expiration; pick the nearest one for default view.
  const byExp: Record<string, typeof data.contracts> = {};
  for (const c of data.contracts) {
    (byExp[c.expiration_date] ??= []).push(c);
  }
  const expirations = Object.keys(byExp).sort();
  const nearest = expirations[0];
  const rows = (byExp[nearest] ?? []).slice().sort((a, b) =>
    Number(a.strike_price) - Number(b.strike_price)
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-muted text-xs">
          Exp <b className="text-text">{nearest}</b> ({expirations.length} expirations available)
        </div>
        <label className="text-muted text-xs flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showAllGreeks}
            onChange={(e) => setShowAllGreeks(e.target.checked)}
          />
          All Greeks
        </label>
      </div>
      <table className="w-full text-xs">
        <thead className="text-muted uppercase tracking-wider text-[9px]">
          <tr>
            <th className="text-left px-2 py-1">Strike</th>
            <th className="text-left px-2 py-1">Type</th>
            <th className="text-right px-2 py-1">Bid</th>
            <th className="text-right px-2 py-1">Ask</th>
            <th className="text-right px-2 py-1">IV</th>
            <th className="text-right px-2 py-1">Δ</th>
            {showAllGreeks && <th className="text-right px-2 py-1">Γ</th>}
            <th className="text-right px-2 py-1">Θ</th>
            {showAllGreeks && <th className="text-right px-2 py-1">ν</th>}
            <th className="text-right px-2 py-1">OI</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const snap = data.snapshots[c.symbol] ?? {};
            const g = snap.greeks ?? { delta: 0, gamma: 0, theta: 0, vega: 0 };
            const klass = c.type === 'call' ? 'text-red' : 'text-green';
            return (
              <tr key={c.symbol} className="border-t border-border">
                <td className="px-2 py-1 text-text">{fmtUsd(Number(c.strike_price))}</td>
                <td className={`px-2 py-1 ${klass}`}>{c.type === 'call' ? 'C' : 'P'}</td>
                <td className="px-2 py-1 text-right">{snap.latestQuote?.bp?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{snap.latestQuote?.ap?.toFixed(2) ?? '—'}</td>
                <td className="px-2 py-1 text-right">{snap.impliedVolatility ? fmtPct(snap.impliedVolatility * 100) : '—'}</td>
                <td className="px-2 py-1 text-right">{g.delta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.gamma?.toFixed(4) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{g.theta?.toFixed(3) ?? '—'}</td>
                {showAllGreeks && <td className="px-2 py-1 text-right">{g.vega?.toFixed(3) ?? '—'}</td>}
                <td className="px-2 py-1 text-right">{snap.openInterest ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): OptionsChain with all 5 greeks (toggle for gamma + vega)"
```

---

### Task 36: News + Wheelability + Earnings + Fundamentals panels

**Files:**
- Create: `dashboard/src/components/lookup/NewsPanel.tsx`
- Create: `dashboard/src/components/lookup/WheelabilityPanel.tsx`
- Create: `dashboard/src/components/lookup/EarningsPanel.tsx`
- Create: `dashboard/src/components/lookup/FundamentalsPanel.tsx`
- Create: `dashboard/src/lib/wheelability.ts`

- [ ] **Step 1: Create `src/lib/wheelability.ts` (port the wheel scoring from the existing skill)**

This computes a 0-100 wheelability score from a snapshot. The exact formula is the same one the existing `lookup` skill uses — port the relevant logic.

```ts
interface ChainContract {
  strike_price: string;
  expiration_date: string;
  type: 'put' | 'call';
}

interface Snapshot {
  latestQuote?: { ap: number; bp: number };
  impliedVolatility?: number;
}

interface WheelInputs {
  stockPrice: number;
  buyingPower: number;
  contracts: ChainContract[];
  snapshots: Record<string, Snapshot>;
}

export interface WheelabilityResult {
  bestStrike: number | null;
  bestExpiration: string | null;
  yieldPct: number | null;
  spread: number | null;
  bpFit: boolean;
  annualizedPct: number | null;
  score: number;
}

export function scoreWheelability(input: WheelInputs): WheelabilityResult {
  const puts = input.contracts.filter((c) => c.type === 'put');
  let best: { strike: number; exp: string; bid: number; ask: number; iv: number; dte: number } | null = null;

  for (const c of puts) {
    const strike = Number(c.strike_price);
    const target = input.stockPrice * 0.9; // ~10% OTM
    const distFromTarget = Math.abs(strike - target);
    const snap = input.snapshots[(c as any).symbol] ?? {};
    if (!snap.latestQuote) continue;
    const dte = Math.max(1, Math.round((+new Date(c.expiration_date) - Date.now()) / 86400000));
    if (dte < 7 || dte > 35) continue;

    const score =
      -distFromTarget * 10 +
      (snap.latestQuote.bp ?? 0) * 100 +
      Math.min(20, 30 - Math.abs(dte - 21));
    if (!best || score > (-Math.abs(best.strike - target) * 10 + best.bid * 100 + Math.min(20, 30 - Math.abs(best.dte - 21)))) {
      best = {
        strike,
        exp: c.expiration_date,
        bid: snap.latestQuote.bp,
        ask: snap.latestQuote.ap,
        iv: snap.impliedVolatility ?? 0,
        dte,
      };
    }
  }

  if (!best) {
    return { bestStrike: null, bestExpiration: null, yieldPct: null, spread: null, bpFit: false, annualizedPct: null, score: 0 };
  }

  const yieldPct = (best.bid / best.strike) * 100;
  const annualizedPct = yieldPct * (365 / best.dte);
  const spread = best.ask - best.bid;
  const bpFit = best.strike * 100 <= input.buyingPower;

  // Score: yield-weighted, spread-penalized, BP-gated.
  let s = 0;
  s += Math.min(40, yieldPct * 35);     // 1% yield → 35 pts (cap 40)
  s += spread < 0.10 ? 20 : spread < 0.25 ? 10 : 0;
  s += bpFit ? 20 : 0;
  s += Math.max(0, 20 - Math.abs(best.dte - 21));
  return {
    bestStrike: best.strike,
    bestExpiration: best.exp,
    yieldPct,
    spread,
    bpFit,
    annualizedPct,
    score: Math.min(100, Math.round(s)),
  };
}
```

- [ ] **Step 2: Create `WheelabilityPanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { scoreWheelability } from '../../lib/wheelability';
import { fmtUsd, fmtPct } from '../../lib/format';
import { useAccount } from '../../hooks/useAccount';

export default function WheelabilityPanel({ symbol }: { symbol: string }) {
  const [accountMode] = useAccount();
  const mode = accountMode === 'aggressive' ? 'aggressive' : 'conservative';

  const chainQ = useQuery({ queryKey: ['chain', symbol], queryFn: () => api<any>(`/api/alpaca/chain?symbol=${symbol}`) });
  const quoteQ = useQuery({ queryKey: ['quote', symbol], queryFn: () => api<any>(`/api/alpaca/quote?symbol=${symbol}`) });
  const acctQ = useQuery({ queryKey: ['account', mode], queryFn: () => api<any>(`/api/alpaca/account?mode=${mode}`) });

  if (chainQ.isLoading || quoteQ.isLoading || acctQ.isLoading) {
    return <div className="text-muted text-xs">Computing…</div>;
  }
  if (!chainQ.data || !quoteQ.data || !acctQ.data) {
    return <div className="text-muted text-xs">Insufficient data.</div>;
  }
  const snap = quoteQ.data.snapshot?.[symbol] ?? quoteQ.data.snapshot;
  const stockPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c;
  if (!stockPrice) return <div className="text-muted text-xs">No price data.</div>;

  const result = scoreWheelability({
    stockPrice,
    buyingPower: Number(acctQ.data.account.buying_power),
    contracts: chainQ.data.contracts.map((c: any) => ({ ...c, symbol: c.symbol })),
    snapshots: chainQ.data.snapshots,
  });

  return (
    <div>
      <div className="text-3xl font-bold text-accent">{result.score} / 100</div>
      {result.bestStrike ? (
        <div className="text-xs text-text mt-2 leading-relaxed">
          Best put: <b>{fmtUsd(result.bestStrike)} · {result.bestExpiration}</b><br />
          Yield: {fmtPct(result.yieldPct ?? 0)} · Spread: {fmtUsd(result.spread ?? 0)} · BP fit {result.bpFit ? '✓' : '✗'}<br />
          Annualized: ~{fmtPct(result.annualizedPct ?? 0)}
        </div>
      ) : (
        <div className="text-xs text-muted mt-2">No suitable put found in 7-35 DTE range.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `NewsPanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface NewsArticle {
  id: number;
  headline: string;
  source: string;
  created_at: string;
  url: string;
}

export default function NewsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['news', symbol],
    queryFn: () => api<{ news: NewsArticle[] }>(`/api/alpaca/news?symbol=${symbol}&limit=10`),
  });
  if (isLoading) return <div className="text-muted text-xs">Loading news…</div>;
  const news = (data?.news ?? []) as any[];
  if (news.length === 0) return <div className="text-muted text-xs">No recent news.</div>;
  return (
    <div className="space-y-2">
      {news.slice(0, 5).map((n) => (
        <a key={n.id} href={n.URL ?? n.url} target="_blank" rel="noreferrer" className="block hover:bg-panel-2/40 rounded p-1 -m-1">
          <div className="text-muted text-[10px]">
            {new Date(n.CreatedAt ?? n.created_at).toLocaleTimeString()} · {n.Source ?? n.source}
          </div>
          <div className="text-text text-xs leading-tight mt-0.5">
            {n.Headline ?? n.headline}
          </div>
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create `EarningsPanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface FundResp {
  fundamentals: { next_earnings_date?: number };
  earnings: Array<{
    date: string;
    eps_estimate: number | null;
    reported_eps: number | null;
    surprise_pct: number | null;
  }>;
}

export default function EarningsPanel({ symbol }: { symbol: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api<FundResp>(`/api/fundamentals-proxy?symbol=${symbol}`),
  });
  if (isLoading) return <div className="text-muted text-xs">Loading earnings…</div>;
  if (!data) return <div className="text-muted text-xs">No earnings data.</div>;

  const past = (data.earnings ?? [])
    .filter((e) => e.reported_eps != null)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date))
    .slice(-4);
  const next = (data.earnings ?? []).find((e) => e.reported_eps == null);
  const beats = past.filter((e) => (e.surprise_pct ?? 0) > 0).length;

  return (
    <div>
      <div className="flex items-baseline justify-between border-b border-border pb-3 mb-3">
        <div>
          <div className="text-text-strong text-base font-semibold">
            {next ? new Date(next.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
          </div>
          <div className="text-muted text-[10px]">
            {next?.eps_estimate != null ? `Est. EPS $${next.eps_estimate.toFixed(2)}` : 'no estimate'}
          </div>
        </div>
        <div className="flex gap-4 text-right">
          <div>
            <div className="text-text font-semibold">{beats} / {past.length}</div>
            <div className="text-muted text-[10px] uppercase tracking-wider">Beat rate</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {past.map((e) => {
          const beat = (e.surprise_pct ?? 0) >= 0;
          const estH = Math.min(90, Math.max(20, 50 + (e.eps_estimate ?? 0) * 5));
          const actH = Math.min(90, Math.max(20, 50 + (e.reported_eps ?? 0) * 5));
          return (
            <div key={e.date} className="flex flex-col items-center">
              <div className="flex items-end gap-1.5 h-[80px]">
                <div className="w-5 bg-panel-2 rounded-sm" style={{ height: `${estH}%` }} />
                <div className={`w-5 rounded-sm ${beat ? 'bg-green' : 'bg-red'}`} style={{ height: `${actH}%` }} />
              </div>
              <div className="text-muted text-[10px] mt-1">{new Date(e.date).toLocaleDateString('en-US', { month: 'short' })}</div>
              <div className={`text-[10px] font-semibold ${beat ? 'text-green' : 'text-red'}`}>
                {(e.surprise_pct ?? 0) >= 0 ? '+' : ''}{(e.surprise_pct ?? 0).toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `FundamentalsPanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';

interface FundResp {
  fundamentals: {
    market_cap?: number;
    pe_ratio?: number;
    sector?: string;
    fifty_two_week_low?: number;
    fifty_two_week_high?: number;
  };
}

export default function FundamentalsPanel({ symbol }: { symbol: string }) {
  const { data } = useQuery({
    queryKey: ['fundamentals', symbol],
    queryFn: () => api<FundResp>(`/api/fundamentals-proxy?symbol=${symbol}`),
  });
  const f = data?.fundamentals ?? {};
  return (
    <dl className="grid grid-cols-2 gap-y-1 text-xs">
      <dt className="text-muted">Market cap</dt>
      <dd className="text-text text-right">{f.market_cap ? `$${(f.market_cap / 1e9).toFixed(1)}B` : '—'}</dd>
      <dt className="text-muted">P/E</dt>
      <dd className="text-text text-right">{f.pe_ratio?.toFixed(1) ?? '—'}</dd>
      <dt className="text-muted">Sector</dt>
      <dd className="text-text text-right">{f.sector ?? '—'}</dd>
      <dt className="text-muted">52w range</dt>
      <dd className="text-text text-right">
        {f.fifty_two_week_low && f.fifty_two_week_high ? `${fmtUsd(f.fifty_two_week_low)} — ${fmtUsd(f.fifty_two_week_high)}` : '—'}
      </dd>
    </dl>
  );
}
```

- [ ] **Step 6: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): NewsPanel + WheelabilityPanel + EarningsPanel + FundamentalsPanel"
```

---

### Task 37: Lookup page assembly + watchlist add button

**Files:**
- Modify: `dashboard/src/routes/Lookup.tsx`

- [ ] **Step 1: Replace `src/routes/Lookup.tsx`**

```tsx
import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api } from '../lib/api';
import QuotePanel from '../components/lookup/QuotePanel';
import PositionContextPanel from '../components/lookup/PositionContextPanel';
import TradingViewChart from '../components/lookup/TradingViewChart';
import OptionsChain from '../components/lookup/OptionsChain';
import EarningsPanel from '../components/lookup/EarningsPanel';
import WheelabilityPanel from '../components/lookup/WheelabilityPanel';
import NewsPanel from '../components/lookup/NewsPanel';
import FundamentalsPanel from '../components/lookup/FundamentalsPanel';

export default function Lookup() {
  const { symbol = '' } = useParams();
  const nav = useNavigate();
  const [search, setSearch] = useState(symbol);
  const sym = symbol.toUpperCase();

  const addToWatchlist = useMutation({
    mutationFn: () => api('/api/kv/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) }),
  });

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const next = search.trim().toUpperCase();
    if (next) nav(`/lookup/${next}`);
  }

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <form onSubmit={onSearch} className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol (e.g. TSLA, SPY, NVDA)…"
          className="w-full bg-panel border border-border rounded-md px-4 py-3 text-text-strong text-base focus:outline-none focus:border-accent"
        />
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* LEFT 2/3 */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <Cell title={`TradingView · ${sym}`}>
            <TradingViewChart symbol={sym} />
          </Cell>
          <Cell title="Options Chain (nearest expiration)">
            <OptionsChain symbol={sym} />
          </Cell>
          <Cell title="Earnings">
            <EarningsPanel symbol={sym} />
          </Cell>
        </div>

        {/* RIGHT 1/3 */}
        <div className="flex flex-col gap-3">
          <Cell title="Quote">
            <QuotePanel symbol={sym} />
            <hr className="border-border my-3" />
            <div className="text-muted text-[10px] uppercase tracking-wider mb-2">Your position</div>
            <PositionContextPanel symbol={sym} />
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                onClick={() => addToWatchlist.mutate()}
                disabled={addToWatchlist.isPending || addToWatchlist.isSuccess}
                className="flex-1 bg-panel-2 border border-border rounded-md py-1.5 text-xs text-text hover:bg-panel-2/70 flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <Star size={12} />
                {addToWatchlist.isSuccess ? 'Added' : 'Watchlist'}
              </button>
            </div>
          </Cell>
          <Cell title="Wheelability score">
            <WheelabilityPanel symbol={sym} />
          </Cell>
          <Cell title="News (recent)">
            <NewsPanel symbol={sym} />
          </Cell>
          <Cell title="Fundamentals">
            <FundamentalsPanel symbol={sym} />
          </Cell>
        </div>
      </div>
    </div>
  );
}

function Cell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-panel border border-border rounded-xl p-3">
      <div className="text-muted text-[10px] uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd dashboard && npm run build
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "feat(dashboard): /lookup/:symbol page with all panels + watchlist add"
```

---

## Milestone 6 — Deploy + smoke test

### Task 38: Generate auth secrets + write the deploy guide

**Files:**
- Create: `dashboard/DEPLOY.md`

- [ ] **Step 1: Generate auth secrets locally (do not commit values)**

```bash
# Run each, paste output into 1Password (or wherever you keep secrets):
openssl rand -hex 32           # → BOT_PUSH_TOKEN (also goes into GitHub Actions)
openssl rand -hex 32           # → SESSION_SECRET
openssl rand -base64 24        # → DASHBOARD_PASSWORD
node -e "import('otplib').then(m => { const s = m.authenticator.generateSecret(); console.log('TOTP_SECRET=', s); console.log('Add to Authenticator app:'); console.log(m.authenticator.keyuri('tim', 'TIM-DASH', s)); })"
```

The last command prints an `otpauth://...` URI. Use a QR code generator (e.g. `qrencode -t ANSIUTF8 "otpauth://..."`) to display it, then scan with Google Authenticator / Authy / 1Password.

Also run the backup-codes generator (created in Task 16.7):

```bash
cd dashboard
npx tsx scripts/generate-backup-codes.ts
```

It prints 8 codes (write them down — paper, password manager, somewhere physical) plus a single `BACKUP_CODES_HASHED=...` line for the env vars.

- [ ] **Step 2: Create `dashboard/DEPLOY.md`**

```markdown
# Deploying the dashboard

## One-time setup

### 1. Provision Vercel project

```bash
cd dashboard
npx vercel link            # link to a new Vercel project
```

In the Vercel dashboard for this project:
- **Settings → General → Root Directory** = `dashboard`
- **Settings → Build & Output Settings** → Framework Preset = "Vite"
- **Settings → Functions → Node.js Version** = 20

### 2. Provision Vercel KV (Upstash Redis)

In the Vercel dashboard:
- **Storage → Create Database → Marketplace → Upstash → Redis**
- Connect it to this project (Production, Preview, Development).
- Verify env vars `KV_REST_API_URL` and `KV_REST_API_TOKEN` are auto-created.

### 3. Set environment variables in Vercel

**Settings → Environment Variables**, add each (apply to Production + Preview + Development):

```
DASHBOARD_PASSWORD=<value from setup>
TOTP_SECRET=<value from setup>
SESSION_SECRET=<value from setup>
BACKUP_CODES_HASHED=<comma-separated from setup>
BOT_PUSH_TOKEN=<value from setup>
ALPACA_API_KEY=<from .env>
ALPACA_API_SECRET=<from .env>
ALPACA_AGG_API_KEY=<from .env>
ALPACA_AGG_API_SECRET=<from .env>
ALPACA_BASE_URL=https://paper-api.alpaca.markets/v2
```

### 4. Add BOT_PUSH_TOKEN to GitHub Actions

`tsronco/TradingBotTest-Claude` → Settings → Secrets and variables → Actions → New repository secret:
- Name: `BOT_PUSH_TOKEN`
- Value: same value you used in step 3

### 5. Configure custom domain

**Settings → Domains** → Add `dash.fattieslearnscoding.com`.
Add the DNS record Vercel shows you (a CNAME) at your DNS provider.

### 6. First deploy

```bash
cd dashboard
npx vercel --prod
```

### 7. Backfill bot state

```bash
gh workflow run tsla-monitor.yml
gh workflow run tsla-monitor-aggressive.yml
gh workflow run congress-copy.yml
```

Wait ~1 minute, then check `https://dash.fattieslearnscoding.com/`.

## Subsequent deploys

```bash
cd dashboard
npx vercel --prod
```

(`git push` does NOT auto-deploy this project — explicit deploy via CLI keeps control.)
```

- [ ] **Step 3: Commit**

```bash
cd ..
git add dashboard/
git commit -m "docs(dashboard): one-time setup + deploy guide"
```

---

### Task 39: First production deploy + end-to-end smoke test

**Files:**
- (no files — runtime verification)

- [ ] **Step 1: Follow DEPLOY.md steps 1-6**

This is a manual step. Don't proceed until `https://dash.fattieslearnscoding.com/login` loads the login form.

- [ ] **Step 2: Log in**

Use your password + a current TOTP code. You should land on `/` (Home) and see a "Loading…" then both Account cards filled in.

- [ ] **Step 3: Visit each page and verify**

- `/` — both Conservative + Aggressive account cards show real equity, BP, cash.
- `/positions` — toggle account selector, see real positions for each.
- `/orders` — see real recent orders for each account.
- `/lookup/SPY` — see chart, quote, options chain (with all 5 Greeks toggle), wheelability score, news, earnings, fundamentals.
- `/lookup/TSLA` — same, plus your position context panel shows current TSLA holdings.

If anything is broken, fix it before continuing.

- [ ] **Step 4: Trigger a workflow + verify bot-state push lands**

```bash
gh workflow run tsla-monitor.yml
```

Wait for the run to complete. Then in Vercel dashboard → Storage → KV → browser, verify `bot:state:conservative` and `bot:strategy:conservative` keys exist with timestamps in `bot:last-update:*`.

- [ ] **Step 5: Add SPY to your watchlist + verify it persists**

Click the "Watchlist" button on `/lookup/SPY`. In Vercel dashboard → Storage → KV → browser, verify the `watchlist` key now contains `["SPY"]`.

- [ ] **Step 6: Test sign-out**

Click "Sign out" in the sidebar. You should be redirected to `/login` and the session cookie should be cleared.

- [ ] **Step 7: Tag the release**

```bash
git tag -a dashboard-phase1 -m "trading dashboard phase 1: foundation + read-only"
git push origin dashboard-phase1
```

- [ ] **Step 8: Mark phase 1 complete**

In `docs/superpowers/specs/2026-05-02-trading-dashboard-design.md`, append a line at the bottom:

```markdown
---

**Phase 1 status:** shipped 2026-XX-XX, deployed at https://dash.fattieslearnscoding.com.
See `docs/superpowers/plans/2026-05-02-trading-dashboard-phase1.md` for the executed plan.
```

Then commit:

```bash
git add docs/superpowers/specs/2026-05-02-trading-dashboard-design.md
git commit -m "docs: mark phase 1 of trading dashboard shipped"
```

---

## Done

Phase 1 is complete. The dashboard is live. The bots are pushing state to KV after each run. You can monitor everything from one URL.

**Next phase:** Phase 2 (manual trading + AI grading) gets its own implementation plan, written from the same spec when you're ready to start it.
