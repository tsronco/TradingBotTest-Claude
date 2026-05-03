from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import yfinance as yf

# yfinance on serverless platforms (Vercel, Lambda) tends to get blocked or
# rate-limited by Yahoo because:
#   (a) the default requests UA looks like a bot, and
#   (b) Vercel's outbound IPs are shared cloud space that Yahoo aggressively
#       throttles for unauthenticated requests.
#
# Strategy: build the strongest session we can, in this priority order:
#   1. curl_cffi browser impersonation — most reliable bypass when it works.
#      Pinned to 0.7.x in requirements because newer 0.10+/0.15+ broke
#      yfinance 0.2.50 with `'str' object has no attribute 'name'`.
#   2. plain requests.Session with a Chrome User-Agent — second best, but
#      already a step above the default.
#   3. None — let yfinance use its built-in default session.
#
# Each yfinance call also has its own try/except so a failure in one call
# (e.g., earnings) doesn't kill the whole response.
SESSION = None
try:
    from curl_cffi import requests as cffi_requests
    SESSION = cffi_requests.Session(impersonate="chrome")
except Exception:
    try:
        import requests as _requests
        SESSION = _requests.Session()
        SESSION.headers.update({
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/131.0.0.0 Safari/537.36'
            ),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        })
    except Exception:
        SESSION = None


def _safe_float(v):
    """Coerce a pandas/numpy cell to a JSON-safe float-or-None.

    yfinance returns NaN for missing values (e.g. upcoming earnings where
    reported EPS isn't filed yet). NaN is NOT valid JSON — `json.dumps`
    emits the literal `NaN` token, which then breaks `JSON.parse` in the
    browser. So we collapse NaN/None to None here.
    """
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN check (NaN is the only float not equal to itself)
        return None
    return f


def _new_ticker(symbol):
    """Try with the global SESSION first, fall back to no session."""
    try:
        return yf.Ticker(symbol, session=SESSION) if SESSION else yf.Ticker(symbol)
    except Exception:
        return yf.Ticker(symbol)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Internal-auth gate: only the TS proxy (which holds INTERNAL_FUNCTIONS_TOKEN)
        # can reach this function. Anything else gets a 401 — the function exists
        # in /api space publicly because Vercel routes Python files there, but
        # we don't want random callers consuming function-execution budget.
        expected_token = os.environ.get('INTERNAL_FUNCTIONS_TOKEN', '')
        provided_token = self.headers.get('X-Internal-Auth', '')
        if not expected_token or provided_token != expected_token:
            self._respond(401, {'error': 'unauthorized'})
            return

        symbol = ''
        try:
            qs = parse_qs(urlparse(self.path).query)
            symbol = (qs.get('symbol') or [''])[0].upper().strip()
            if not symbol or not symbol.replace('.', '').replace('-', '').isalnum():
                self._respond(400, {'error': 'invalid_symbol'})
                return

            warnings = []
            t = _new_ticker(symbol)

            # info: fundamentals (market cap, P/E, sector, etc.).
            info = {}
            try:
                info = t.info or {}
            except Exception as e:
                warnings.append(f'info failed: {type(e).__name__}: {e}')

            # Earnings dates: returns a DataFrame; convert to list of dicts.
            earnings = []
            try:
                edf = t.get_earnings_dates(limit=12)
                if edf is not None:
                    for idx, r in edf.iterrows():
                        earnings.append({
                            'date': str(idx),
                            'eps_estimate': _safe_float(r.get('EPS Estimate')),
                            'reported_eps': _safe_float(r.get('Reported EPS')),
                            'surprise_pct': _safe_float(r.get('Surprise(%)')),
                        })
            except Exception as e:
                warnings.append(f'earnings failed: {type(e).__name__}: {e}')

            payload = {
                'symbol': symbol,
                'fundamentals': {
                    'market_cap': _safe_float(info.get('marketCap')),
                    'pe_ratio': _safe_float(info.get('trailingPE')),
                    'sector': info.get('sector'),
                    'industry': info.get('industry'),
                    'fifty_two_week_low': _safe_float(info.get('fiftyTwoWeekLow')),
                    'fifty_two_week_high': _safe_float(info.get('fiftyTwoWeekHigh')),
                    'next_earnings_date': _safe_float(info.get('earningsTimestamp')),
                },
                'earnings': earnings,
            }
            if warnings:
                payload['warnings'] = warnings
            self._respond(200, payload)
        except Exception as e:
            self._respond(502, {
                'error': 'fundamentals_failed',
                'detail': str(e),
                'symbol': symbol,
                'fundamentals': {},
                'earnings': [],
            })

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 's-maxage=3600, stale-while-revalidate')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode('utf-8'))
