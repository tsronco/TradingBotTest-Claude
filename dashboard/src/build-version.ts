// Dashboard build version — the single source read by the header BUILD pill and
// the sidebar. Format: major.bot.dashboard
//   • major     — 0 while we're pre-live; bump to 1 the day we go live.
//   • bot       — +1 each time we ship a real BOT change (strategy / config / workflow).
//   • dashboard — +1 each time we ship a real DASHBOARD change.
//
// Bumped at ship time by `npm run bump` (tools/bump-version.mjs), which auto-picks
// the segment(s) from what actually changed. The every-10-minute bot state pushes
// (logs/*.jsonl, *_state*.json) never count. Seeded from project history (313 bot /
// 224 dashboard real commits) and bumped by this very change to a clean 0.3.22.
// A major bump (`npm run bump:major`, e.g. at go-live → 1.0.0) resets bot & dash
// to 0 — standard semver, and what keeps the numbers from growing without bound.
export const BUILD_VERSION = '0.3.25';
