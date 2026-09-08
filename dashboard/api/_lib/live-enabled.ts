/**
 * Live (real-money) trading switch for the dashboard.
 *
 * Live order placement, modify, cancel, and activity import from the dashboard
 * are ON by default as of 2026-09-08 (Tim's go-live for hand-placed live
 * trades). `LIVE_ENABLED=false` in the Vercel env is the kill switch — set it
 * to take the dashboard back to read-only on live without a redeploy.
 *
 * Any other value (unset, "true", "1", …) means enabled. The bots are
 * unaffected either way: they run on GitHub Actions with their own creds. The
 * autonomous agent account is paper-only and never touches live.
 *
 * Kept in its own dependency-free module so API handlers and tests can import
 * it without pulling in the Alpaca client (which many tests mock wholesale).
 */
export function liveTradingEnabled(): boolean {
  return process.env.LIVE_ENABLED !== 'false';
}
