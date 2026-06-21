// Bump src/build-version.ts. Two modes:
//
//   npm run bump          — tick bot and/or dashboard based on what is STAGED.
//   npm run bump:major    — bump the major and RESET bot+dash to 0 (e.g. go-live
//                           → 1.0.0). This is the "reset button" that keeps the
//                           numbers from growing without bound — standard semver.
//
// Ship workflow (normal bump):
//   1. make your change(s)
//   2. git add <your change>      (e.g. git add dashboard/  — or the bot files)
//   3. npm run bump               (ticks the right segment, stages build-version.ts)
//   4. git commit ...             (change + version bump together)
//   5. deploy
//
// Format: major.bot.dashboard. The middle digit ticks on real BOT changes (any
// staged file outside dashboard/ that isn't a state push), the last on real
// DASHBOARD changes (staged files under dashboard/). State pushes (logs/,
// *_state*.json, congress-copy/data/) and the version file itself never count.
// Reading the *staged* set (not `git status`) keeps stray untracked files out.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const versionFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'build-version.ts');
const root = execSync('git rev-parse --show-toplevel').toString().trim();
const majorMode = process.argv.includes('--major');

const src = readFileSync(versionFile, 'utf8');
const m = src.match(/BUILD_VERSION = '(\d+)\.(\d+)\.(\d+)'/);
if (!m) { console.error('bump-version: could not parse BUILD_VERSION in build-version.ts'); process.exit(1); }

let [maj, bot, dash] = [Number(m[1]), Number(m[2]), Number(m[3])];
const before = `${maj}.${bot}.${dash}`;
let after;
let note;

if (majorMode) {
  after = `${maj + 1}.0.0`;
  note = 'MAJOR — bot & dash reset to 0';
} else {
  const files = execSync('git diff --cached --name-only', { cwd: root })
    .toString().trim().split('\n').filter(Boolean);

  const isState = (f) =>
    f.startsWith('logs/') ||
    f.startsWith('congress-copy/data/') ||
    /(^|\/)(strategy_state|wheel_state)[^/]*\.json$/.test(f);
  const isVersionFile = (f) => f === 'dashboard/src/build-version.ts';

  const dashChanged = files.some((f) => f.startsWith('dashboard/') && !isVersionFile(f));
  const botChanged = files.some((f) => !f.startsWith('dashboard/') && !isState(f));

  if (!botChanged && !dashChanged) {
    console.log(`bump-version: nothing relevant staged — version stays ${before}. (Did you 'git add' your change first?)`);
    process.exit(0);
  }
  if (botChanged) bot += 1;
  if (dashChanged) dash += 1;
  after = `${maj}.${bot}.${dash}`;
  note = `bot ${botChanged ? '+1' : '—'}, dashboard ${dashChanged ? '+1' : '—'}`;
}

writeFileSync(versionFile, src.replace(/BUILD_VERSION = '[^']*'/, `BUILD_VERSION = '${after}'`));
execSync(`git add "${versionFile}"`, { cwd: root });
console.log(`bump-version: ${before} -> ${after}   (${note})  [staged]`);
