// Bump src/build-version.ts based on what is STAGED for the next commit.
//
// Ship workflow:
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

const files = execSync('git diff --cached --name-only', { cwd: root })
  .toString().trim().split('\n').filter(Boolean);

const isState = (f) =>
  f.startsWith('logs/') ||
  f.startsWith('congress-copy/data/') ||
  /(^|\/)(strategy_state|wheel_state)[^/]*\.json$/.test(f);
const isVersionFile = (f) => f === 'dashboard/src/build-version.ts';

const dashChanged = files.some((f) => f.startsWith('dashboard/') && !isVersionFile(f));
const botChanged = files.some((f) => !f.startsWith('dashboard/') && !isState(f));

const src = readFileSync(versionFile, 'utf8');
const m = src.match(/BUILD_VERSION = '(\d+)\.(\d+)\.(\d+)'/);
if (!m) { console.error('bump-version: could not parse BUILD_VERSION in build-version.ts'); process.exit(1); }

let [maj, bot, dash] = [Number(m[1]), Number(m[2]), Number(m[3])];
const before = `${maj}.${bot}.${dash}`;
if (botChanged) bot += 1;
if (dashChanged) dash += 1;
const after = `${maj}.${bot}.${dash}`;

if (!botChanged && !dashChanged) {
  console.log(`bump-version: nothing relevant staged — version stays ${before}. (Did you 'git add' your change first?)`);
  process.exit(0);
}

writeFileSync(versionFile, src.replace(/BUILD_VERSION = '[^']*'/, `BUILD_VERSION = '${after}'`));
execSync(`git add "${versionFile}"`, { cwd: root });
console.log(`bump-version: ${before} -> ${after}   (bot ${botChanged ? '+1' : '—'}, dashboard ${dashChanged ? '+1' : '—'})  [staged]`);
