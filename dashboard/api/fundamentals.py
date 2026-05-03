from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import os
import yfinance as yf


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
            except Exception:  # yfinance can throw on missing data
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
