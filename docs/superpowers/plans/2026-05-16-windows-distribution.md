# Windows Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the daily runner + farming pipeline to non-tech Windows users as a single ~50 MB portable ZIP with three `.bat` files (setup → bootstrap → start), distributed via GitHub Releases and announced on Telegram.

**Architecture:** Add a TypeScript build step that emits plain JS to `dist/`. Centralize all on-disk paths (`sessions/`, `config/`, `logs/`, `data/`) behind a single `paths.ts` module so the same code runs in dev (paths under repo root) and in the Windows ZIP (paths under the install folder). Ship a static country catalog (74 entries) plus a name→ID resolver used by the setup wizard. Build the release artifact on `windows-latest` via GitHub Actions on tag push. Chromium downloads on first `bootstrap.bat`, pinned indirectly via the `cloakbrowser` package version.

**Tech Stack:** Node 22 (portable Windows distribution), TypeScript 5, `tsx` (dev), `tsc` (build), `cloakbrowser` (stealth Chromium), `vitest` (added by this plan for the country resolver), `dotenv`, `zod`, GitHub Actions, Windows `cmd.exe` batch scripting.

---

## File structure overview

**New files:**

| Path | Purpose |
|---|---|
| `tsconfig.build.json` | tsc emit configuration (separate from dev's `noEmit`) |
| `vitest.config.ts` | Vitest config (root, ESM) |
| `src/paths.ts` | Central path helpers (`sessionsDir`, `configDir`, `logsDir`, `dataDir`) reading from env with cwd defaults |
| `src/util/resolveCountries.ts` | Pure function mapping name/code/id input → IDs + suggestions |
| `src/util/resolveCountriesCli.ts` | CLI bridge used by `setup.bat` |
| `src/util/resolveCountries.test.ts` | Unit tests for the resolver |
| `scripts/validate-countries-json.ts` | Drift detector against the live API |
| `windows/setup.bat` | Interactive English config wizard |
| `windows/bootstrap.bat` | First-run Chromium fetch + headed login |
| `windows/start.bat` | Long-running daily runner launcher |
| `windows/stop.bat` | Graceful shutdown via PID file |
| `windows/README.txt` | Plain-text English instructions |
| `.github/workflows/release-windows.yml` | Release pipeline on tag push |

**Modified files:**

| Path | Change |
|---|---|
| `package.json` | Add `build` and `test` scripts; add `vitest` dev dep |
| `src/bootstrap.ts` | Use `paths.ts` for profile dir; configurable dotenv path |
| `src/memory/dailyState.ts` | Use `paths.ts` instead of local `SESSIONS_DIR` |
| `src/memory/weeklyState.ts` | Same |
| `src/memory/weeklyFuelState.ts` | Same |
| `src/browser/session.ts` | Use `paths.ts` for profile dir |
| `src/agent/runner.ts` | Configurable dotenv path; PID file write/delete; optional tee to log file when `ERP_FILE_LOGGING=true` |
| `.gitignore` | Ignore `dist/`, `config/`, `logs/`, `data/.*` (none of these belong in git output) |

**Already committed:**

- `data/countries.json` — 74 entries, source-of-truth catalog.
- `docs/superpowers/specs/2026-05-16-windows-distribution-design.md` — the approved spec.

---

## Task 1: TypeScript build step

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Add `build` script to `package.json`**

In the `"scripts"` block, add a new entry just before `"typecheck"`:

```json
"build": "tsc -p tsconfig.build.json",
```

- [ ] **Step 3: Update `.gitignore` to ignore `dist/`**

Current `.gitignore` already has `dist/` per `node_modules/` / `sessions/` style — verify it's there. If not, append:

```
dist/
```

- [ ] **Step 4: Run the build**

```bash
npm run build
```

Expected output: no errors. A `dist/` directory appears with `agent/runner.js`, `bootstrap.js`, `farm/`, `tools/`, etc. — every `src/**/*.ts` (excluding tests, none exist yet) is compiled to `.js`.

- [ ] **Step 5: Smoke-test the compiled bootstrap**

```bash
HEADED=true node dist/bootstrap.js
```

Expected: same behavior as `npm run bootstrap` — a headed Chromium opens (you may close it immediately). The script exits with 0 if already logged in, 1 if not. This confirms imports resolve correctly against the compiled output.

If you see `ERR_MODULE_NOT_FOUND` for a `../foo.js` import, the source already uses `.js` suffix (per the codebase convention) and this should not happen. If it does, inspect `dist/` to verify the file structure mirrors `src/`.

- [ ] **Step 6: Commit**

```bash
git add tsconfig.build.json package.json .gitignore
git commit -m "build: add tsc build step emitting to dist/

Adds tsconfig.build.json (extends root tsconfig with noEmit:false)
and an npm run build script. Source tree keeps using .js import
suffixes per the existing ESM + bundler-resolution convention, so
the compiled output is drop-in runnable as node dist/agent/runner.js."
```

---

## Task 2: Centralize runtime paths

**Files:**
- Create: `src/paths.ts`
- Modify: `src/memory/dailyState.ts`
- Modify: `src/memory/weeklyState.ts`
- Modify: `src/memory/weeklyFuelState.ts`
- Modify: `src/browser/session.ts`
- Modify: `src/bootstrap.ts`
- Modify: `src/agent/runner.ts`

- [ ] **Step 1: Create `src/paths.ts`**

```typescript
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Root directory anchor for on-disk state. Defaults to process.cwd() so the
 * developer workflow keeps using paths relative to the repo root. The Windows
 * .bat files set ERP_ROOT to the ZIP install folder so the agent finds
 * sessions/, config/, logs/, and data/ there.
 */
function root(): string {
  return resolve(process.env.ERP_ROOT ?? process.cwd());
}

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionsDir(): string {
  return ensure(resolve(root(), 'sessions'));
}

export function configDir(): string {
  return ensure(resolve(root(), 'config'));
}

export function logsDir(): string {
  return ensure(resolve(root(), 'logs'));
}

export function dataDir(): string {
  // No ensure() — data/ is read-only and shipped in the artifact.
  return resolve(root(), 'data');
}

export function profileDir(accountSlug: string): string {
  return ensure(resolve(sessionsDir(), 'profile', accountSlug));
}
```

- [ ] **Step 2: Update `src/memory/dailyState.ts`**

Replace lines 1-8 (the imports and the `SESSIONS_DIR` constant):

```typescript
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from '../paths.js';
import { DailyState, emptyState } from './schema.js';

function ensureDir(): void {
  // sessionsDir() already mkdirs.
  sessionsDir();
}

function filePath(day: number): string {
  return join(sessionsDir(), `daily-state-${day}.json`);
}

function archivePath(day: number): string {
  return join(sessionsDir(), `daily-state-${day}.archive.json`);
}
```

Then in the body of the file: replace every remaining use of `SESSIONS_DIR` with a call to `sessionsDir()`.

- [ ] **Step 3: Update `src/memory/weeklyState.ts`**

Same shape: remove the `SESSIONS_DIR` constant, replace usages with `sessionsDir()`.

- [ ] **Step 4: Update `src/memory/weeklyFuelState.ts`**

Same shape.

- [ ] **Step 5: Update `src/browser/session.ts`**

Find line 12:

```typescript
const profileDir = resolve(`sessions/profile/${opts.accountSlug}`);
```

Replace with:

```typescript
import { profileDir as resolveProfileDir } from '../paths.js';
// (place import at the top of the file alongside the existing imports;
// remove the unused `resolve` import if it's no longer referenced.)

// ... inside the function:
const profileDir = resolveProfileDir(opts.accountSlug);
```

- [ ] **Step 6: Update `src/bootstrap.ts`**

Replace line 16:

```typescript
const profileDir = resolve(`sessions/profile/${env.ERP_ACCOUNT_SLUG}`);
mkdirSync(profileDir, { recursive: true });
```

Replace lines 1-5 imports and the profileDir line with:

```typescript
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { z } from 'zod';
import { launchPersistentContext } from 'cloakbrowser';
import { configDir, profileDir } from './paths.js';

loadDotenv({ path: join(configDir(), '.env') });
// Fall back to default .env in cwd if config/.env wasn't found
// (developer workflow). Dotenv silently ignores missing files.
loadDotenv();

const Env = z.object({
  ERP_LOGIN: z.string().email(),
  ERP_PASSWORD: z.string().min(1),
  ERP_ACCOUNT_SLUG: z.string().default('main'),
  HEADED: z.enum(['true', 'false']).default('true'),
});

const env = Env.parse(process.env);

const dir = profileDir(env.ERP_ACCOUNT_SLUG);

console.log(`[bootstrap] profile dir: ${dir}`);
console.log(`[bootstrap] launching CloakBrowser (headed=${env.HEADED})`);

const ctx = await launchPersistentContext({
  userDataDir: dir,
  headless: env.HEADED === 'false',
  viewport: { width: 1366, height: 800 },
});
```

The rest of `bootstrap.ts` (page navigation, login flow, cookie check, ctx.close) stays unchanged.

- [ ] **Step 7: Update `src/agent/runner.ts`**

At the top of the file (line 1), replace `import 'dotenv/config';` with the same two-step load:

```typescript
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';
import { configDir } from '../paths.js';

loadDotenv({ path: join(configDir(), '.env') });
loadDotenv();
```

Keep all the rest of the imports.

- [ ] **Step 8: Sanity check — both entry points still type-check**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 9: Sanity check — dev workflow still works**

```bash
npm run agent
```

Expected: same behavior as before. Reads `.env` from repo root (because `config/.env` doesn't exist for the developer) and runs one cycle.

- [ ] **Step 10: Sanity check — `ERP_ROOT` override works**

```bash
mkdir -p /tmp/erp-test/config /tmp/erp-test/sessions
cp .env /tmp/erp-test/config/.env
ERP_ROOT=/tmp/erp-test npm run agent
```

Expected: still runs, but creates `sessions/` and looks for `.env` under `/tmp/erp-test/`. Verify that `/tmp/erp-test/sessions/daily-state-*.json` is written.

Clean up afterwards: `rm -rf /tmp/erp-test`.

- [ ] **Step 11: Commit**

```bash
git add src/paths.ts src/memory/ src/browser/session.ts src/bootstrap.ts src/agent/runner.ts
git commit -m "refactor: centralize on-disk paths behind src/paths.ts

Introduces sessionsDir/configDir/logsDir/dataDir/profileDir helpers
that read ERP_ROOT (default: process.cwd()). Dotenv now loads from
{root}/config/.env first, then falls back to default cwd .env so
the developer workflow is unchanged. Required by the Windows ZIP
distribution where the install folder is the root."
```

---

## Task 3: PID file + optional file logging in the runner

**Files:**
- Modify: `src/agent/runner.ts`

- [ ] **Step 1: Extend the Env schema**

In `src/agent/runner.ts` Env zod schema (currently around lines 26-44), add:

```typescript
ERP_FILE_LOGGING: z.enum(['true', 'false']).default('false'),
```

- [ ] **Step 2: Write the PID file on startup**

Add this near the top of the script's effect section, after `const env = Env.parse(process.env);` and before the main loop:

```typescript
import { writeFileSync, unlinkSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';

const pidPath = join(logsDir(), 'agent.pid');
writeFileSync(pidPath, String(process.pid));

const cleanupPid = (): void => {
  try { unlinkSync(pidPath); } catch { /* ignore */ }
};
process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(130); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(143); });
```

The `taskkill /F` from `stop.bat` won't fire these handlers, but the PID file is overwritten on next `start.bat` anyway — stale PID is harmless.

- [ ] **Step 3: Tee `console.log`/`console.error` to a daily log file when enabled**

Add right after the PID setup:

```typescript
if (env.ERP_FILE_LOGGING === 'true') {
  // Daily rotation matches the eRepublik day boundary the agent already uses.
  // The runner re-reads the day each cycle; for logging we just use ISO date
  // because operators reading logs think in calendar days, not game days.
  const stamp = new Date().toISOString().slice(0, 10);
  const stream = createWriteStream(join(logsDir(), `agent-${stamp}.log`), { flags: 'a' });

  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    origLog(...args);
    stream.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    stream.write('[ERR] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
}
```

- [ ] **Step 4: Verify typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Verify behavior — flag off (default)**

```bash
npm run agent
```

Expected: identical pre-task behavior. No new file in `logs/`.

- [ ] **Step 6: Verify behavior — flag on**

```bash
ERP_FILE_LOGGING=true npm run agent
```

Expected: `logs/agent.pid` exists during run (deleted on clean exit), and `logs/agent-YYYY-MM-DD.log` contains every console output the cycle produced. Inspect with `cat logs/agent-*.log | head -20`.

- [ ] **Step 7: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat: optional PID file + tee logging gated on ERP_FILE_LOGGING

Agent writes its PID to logs/agent.pid on startup and removes it on
clean exit, so the Windows stop.bat can taskkill the process. When
ERP_FILE_LOGGING=true, console output is duplicated to logs/agent-
YYYY-MM-DD.log so non-tech users can ship a single log file when
asking for support."
```

---

## Task 4: Country resolver (TDD with vitest)

**Files:**
- Create: `vitest.config.ts`
- Create: `src/util/resolveCountries.ts`
- Create: `src/util/resolveCountries.test.ts`
- Create: `src/util/resolveCountriesCli.ts`
- Create: `scripts/validate-countries-json.ts`
- Modify: `package.json`

- [ ] **Step 1: Add vitest as a dev dependency**

```bash
npm install --save-dev vitest@^2
```

Expected: `package.json` gains `"vitest": "^2.x"` in `devDependencies`. No runtime deps change.

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add a `test` script to `package.json`**

In the `"scripts"` block, add right after `"typecheck"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write failing tests for `resolveCountries`**

Create `src/util/resolveCountries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveCountries, type Country } from './resolveCountries.js';

const catalog: Country[] = [
  { id: 1, name: 'Romania' },
  { id: 27, name: 'Argentina' },
  { id: 35, name: 'Poland' },
  { id: 24, name: 'USA' },
  { id: 29, name: 'United Kingdom' },
];

describe('resolveCountries', () => {
  it('returns empty result for blank input', () => {
    const r = resolveCountries('', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('returns empty result for whitespace-only input', () => {
    const r = resolveCountries('   ', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  it('resolves a single numeric ID present in the catalog', () => {
    const r = resolveCountries('27', catalog);
    expect(r.ids).toEqual([27]);
    expect(r.unknown).toEqual([]);
  });

  it('rejects a numeric ID not in the catalog', () => {
    const r = resolveCountries('999', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['999']);
  });

  it('resolves a name match case-insensitively', () => {
    const r = resolveCountries('poland', catalog);
    expect(r.ids).toEqual([35]);
    expect(r.unknown).toEqual([]);
  });

  it('resolves multi-word names', () => {
    const r = resolveCountries('United Kingdom', catalog);
    expect(r.ids).toEqual([29]);
  });

  it('handles a mix of names and IDs', () => {
    const r = resolveCountries('Poland, 27, USA', catalog);
    expect(r.ids).toEqual([35, 27, 24]);
  });

  it('trims whitespace around tokens', () => {
    const r = resolveCountries('  Poland  ,  27  ', catalog);
    expect(r.ids).toEqual([35, 27]);
  });

  it('dedupes the resolved list', () => {
    const r = resolveCountries('Poland, 35, poland', catalog);
    expect(r.ids).toEqual([35]);
  });

  it('reports unknown tokens with a suggestion when close', () => {
    const r = resolveCountries('Polnd', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['Polnd']);
    expect(r.suggestions['Polnd']).toBe('Poland');
  });

  it('reports unknown tokens without a suggestion when nothing is close', () => {
    const r = resolveCountries('zzzzz', catalog);
    expect(r.ids).toEqual([]);
    expect(r.unknown).toEqual(['zzzzz']);
    expect(r.suggestions['zzzzz']).toBeUndefined();
  });

  it('returns partial results when some tokens are unknown', () => {
    const r = resolveCountries('Poland, FakeCountry, 27', catalog);
    expect(r.ids).toEqual([35, 27]);
    expect(r.unknown).toEqual(['FakeCountry']);
  });
});
```

- [ ] **Step 5: Run tests, verify they fail**

```bash
npm test
```

Expected: all 12 tests fail because `resolveCountries.ts` does not exist.

- [ ] **Step 6: Implement `resolveCountries`**

Create `src/util/resolveCountries.ts`:

```typescript
export interface Country {
  id: number;
  name: string;
}

export interface ResolveResult {
  ids: number[];
  unknown: string[];
  suggestions: Record<string, string>;
}

/**
 * Resolves a comma-separated list of country names or IDs against the catalog.
 * Name matching is case-insensitive. Unknown tokens get a fuzzy suggestion
 * when a catalog entry is within Levenshtein distance 2.
 */
export function resolveCountries(input: string, catalog: Country[]): ResolveResult {
  const tokens = input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const byId = new Map(catalog.map((c) => [c.id, c]));
  const byName = new Map(catalog.map((c) => [c.name.toLowerCase(), c]));

  const ids: number[] = [];
  const seen = new Set<number>();
  const unknown: string[] = [];
  const suggestions: Record<string, string> = {};

  for (const token of tokens) {
    const numeric = /^\d+$/.test(token) ? Number(token) : null;
    if (numeric !== null) {
      if (byId.has(numeric)) {
        if (!seen.has(numeric)) {
          ids.push(numeric);
          seen.add(numeric);
        }
      } else {
        unknown.push(token);
      }
      continue;
    }

    const named = byName.get(token.toLowerCase());
    if (named) {
      if (!seen.has(named.id)) {
        ids.push(named.id);
        seen.add(named.id);
      }
      continue;
    }

    unknown.push(token);
    const suggestion = closestName(token, catalog);
    if (suggestion) {
      suggestions[token] = suggestion;
    }
  }

  return { ids, unknown, suggestions };
}

function closestName(token: string, catalog: Country[]): string | null {
  let best: { name: string; distance: number } | null = null;
  const lower = token.toLowerCase();

  for (const c of catalog) {
    const d = levenshtein(lower, c.name.toLowerCase());
    if (d <= 2 && (best === null || d < best.distance)) {
      best = { name: c.name, distance: d };
    }
  }

  return best?.name ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const curr = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return curr[b.length];
}
```

- [ ] **Step 7: Run tests, verify they pass**

```bash
npm test
```

Expected: all 12 tests pass.

- [ ] **Step 8: Write the CLI bridge**

Create `src/util/resolveCountriesCli.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../paths.js';
import { resolveCountries, type Country } from './resolveCountries.js';

const args = process.argv.slice(2);
const catalog = JSON.parse(readFileSync(join(dataDir(), 'countries.json'), 'utf8')) as Country[];

if (args[0] === '--list') {
  // Print the catalog in three columns sorted by name, with IDs aligned.
  const rows = [...catalog]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `${String(c.id).padStart(3, ' ')}  ${c.name}`);

  const COLS = 3;
  const colHeight = Math.ceil(rows.length / COLS);
  const cells: string[][] = [];
  for (let r = 0; r < colHeight; r++) {
    const row: string[] = [];
    for (let c = 0; c < COLS; c++) {
      const idx = c * colHeight + r;
      row.push((rows[idx] ?? '').padEnd(28, ' '));
    }
    cells.push(row);
  }
  for (const row of cells) console.log(row.join(''));
  process.exit(0);
}

const input = args.join(' ');
const result = resolveCountries(input, catalog);

if (result.unknown.length > 0) {
  console.error('Unrecognized country tokens:');
  for (const token of result.unknown) {
    const suggestion = result.suggestions[token];
    console.error(suggestion ? `  - "${token}" — did you mean "${suggestion}"?` : `  - "${token}"`);
  }
  process.exit(1);
}

// Success: print CSV of resolved IDs (or empty line if nothing was provided).
process.stdout.write(result.ids.join(','));
```

- [ ] **Step 9: Test the CLI bridge end-to-end**

```bash
npm run build
node dist/util/resolveCountriesCli.js --list | head -5
node dist/util/resolveCountriesCli.js "Poland, Argentina, 1"
echo "Exit: $?"
node dist/util/resolveCountriesCli.js "Polnd"
echo "Exit: $?"
```

Expected output:
- `--list` prints a three-column country table starting with names like "Albania", "Argentina", "Armenia"
- `"Poland, Argentina, 1"` prints `35,27,1` with exit 0
- `"Polnd"` prints "Unrecognized country tokens: - "Polnd" — did you mean "Poland"?" with exit 1

- [ ] **Step 10: Write the drift validator script**

Create `scripts/validate-countries-json.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Country {
  id: number;
  name: string;
}

interface ApiResponse {
  countries: Record<string, { id: number; name: string }>;
}

const URL = 'https://www.erepublik.com/en/military/campaignsJson/list';
const COMMITTED_PATH = resolve('data/countries.json');

async function main(): Promise<void> {
  const response = await fetch(URL);
  if (!response.ok) {
    console.error(`Failed to fetch ${URL}: HTTP ${response.status}`);
    process.exit(2);
  }

  const body = (await response.json()) as ApiResponse;
  const live = Object.values(body.countries)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.id - b.id);

  const committed = JSON.parse(readFileSync(COMMITTED_PATH, 'utf8')) as Country[];

  const liveById = new Map(live.map((c) => [c.id, c.name]));
  const committedById = new Map(committed.map((c) => [c.id, c.name]));

  const added: Country[] = [];
  const removed: Country[] = [];
  const renamed: Array<{ id: number; before: string; after: string }> = [];

  for (const [id, name] of liveById) {
    if (!committedById.has(id)) {
      added.push({ id, name });
    } else if (committedById.get(id) !== name) {
      renamed.push({ id, before: committedById.get(id)!, after: name });
    }
  }

  for (const [id, name] of committedById) {
    if (!liveById.has(id)) {
      removed.push({ id, name });
    }
  }

  if (added.length === 0 && removed.length === 0 && renamed.length === 0) {
    console.log(`OK: ${live.length} countries match data/countries.json`);
    process.exit(0);
  }

  console.error('Country catalog drift detected:');
  if (added.length > 0) {
    console.error('  Added (in API, missing from committed file):');
    for (const c of added) console.error(`    + id=${c.id} ${c.name}`);
  }
  if (removed.length > 0) {
    console.error('  Removed (in committed file, missing from API):');
    for (const c of removed) console.error(`    - id=${c.id} ${c.name}`);
  }
  if (renamed.length > 0) {
    console.error('  Renamed:');
    for (const r of renamed) console.error(`    ~ id=${r.id} "${r.before}" -> "${r.after}"`);
  }
  console.error('');
  console.error('Update data/countries.json and review the diff before committing.');
  process.exit(1);
}

void main();
```

- [ ] **Step 11: Run the validator**

```bash
npx tsx scripts/validate-countries-json.ts
```

Expected output: `OK: 74 countries match data/countries.json` (or a drift report if eRepublik has added a country since spec drafting; in that case, update `data/countries.json` accordingly before continuing).

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/util/ scripts/validate-countries-json.ts
git commit -m "feat: country resolver + drift validator for Windows setup wizard

Adds vitest as a dev dep, then writes resolveCountries(input,
catalog) → {ids, unknown, suggestions} with Levenshtein-based
suggestions for typos. CLI bridge is invoked by setup.bat to
convert user input like 'Poland, 27' to the CSV IDs that go into
ERP_FARM_BLOCKED_COUNTRIES. Validator script catches drift between
the committed data/countries.json and the live campaignsJson API."
```

---

## Task 5: Windows `.bat` files

**Files:**
- Create: `windows/setup.bat`
- Create: `windows/bootstrap.bat`
- Create: `windows/start.bat`
- Create: `windows/stop.bat`
- Create: `windows/README.txt` (full content in Task 8 — this task ships a stub)

> **Note on testing.** These scripts can be syntax-checked locally on macOS/Linux by reading them, but real verification requires a Windows machine — see Task 7. Use `unix2dos windows/*.bat` (or `sed -i 's/$/\r/'`) before shipping, since Windows cmd.exe is strict about line endings.

- [ ] **Step 1: Create `windows/setup.bat`**

This is the largest single file — an interactive English wizard. Walks through every required env var. The flow follows §5.1 of the spec.

```batch
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo =====================================================
echo   erepublik-agent setup
echo =====================================================
echo.
echo This wizard will configure the bot. Press Enter to
echo keep the default shown in [brackets], or type a new
echo value. Run this again any time to change settings.
echo.

if not exist config mkdir config
set "ENVFILE=config\.env"
set "TMPFILE=config\.env.new"

:: Read existing values into variables if .env already exists.
:: For simplicity we re-prompt for everything; existing values
:: are shown as defaults so blank input keeps them.
set "CUR_LOGIN="
set "CUR_PASSWORD="
set "CUR_SLUG=main"
set "CUR_MAX_FOOD=3.0"
set "CUR_HEADED=false"
set "CUR_LOOP=600000"
set "CUR_FARM_MAX_CC=400"
set "CUR_FARM_MIN_FUEL=10"
set "CUR_FARM_BLOCKED_CSV="
set "CUR_RETURN_HOME_MIN=15"
set "CUR_RETURN_HOME_MAX_CC=500"
set "CUR_TG_TOKEN="
set "CUR_TG_CHAT="
set "CUR_CAPTCHA=none"
set "CUR_CAPTCHA_KEY="

if exist "%ENVFILE%" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ENVFILE%") do (
        if "%%a"=="ERP_LOGIN" set "CUR_LOGIN=%%b"
        if "%%a"=="ERP_PASSWORD" set "CUR_PASSWORD=%%b"
        if "%%a"=="ERP_ACCOUNT_SLUG" set "CUR_SLUG=%%b"
        if "%%a"=="ERP_MAX_FOOD_PRICE" set "CUR_MAX_FOOD=%%b"
        if "%%a"=="HEADED" set "CUR_HEADED=%%b"
        if "%%a"=="LOOP_INTERVAL_MS" set "CUR_LOOP=%%b"
        if "%%a"=="ERP_FARM_MAX_TRAVEL_CC" set "CUR_FARM_MAX_CC=%%b"
        if "%%a"=="ERP_FARM_MIN_FUEL" set "CUR_FARM_MIN_FUEL=%%b"
        if "%%a"=="ERP_FARM_BLOCKED_COUNTRIES" set "CUR_FARM_BLOCKED_CSV=%%b"
        if "%%a"=="ERP_RETURN_HOME_AFTER_MINUTES" set "CUR_RETURN_HOME_MIN=%%b"
        if "%%a"=="ERP_RETURN_HOME_MAX_CC" set "CUR_RETURN_HOME_MAX_CC=%%b"
        if "%%a"=="TELEGRAM_BOT_TOKEN" set "CUR_TG_TOKEN=%%b"
        if "%%a"=="TELEGRAM_CHAT_ID" set "CUR_TG_CHAT=%%b"
        if "%%a"=="ERP_CAPTCHA_PROVIDER" set "CUR_CAPTCHA=%%b"
        if "%%a"=="ERP_CAPTCHA_API_KEY" set "CUR_CAPTCHA_KEY=%%b"
    )
)

echo --- Account ---
call :prompt "eRepublik email address" "%CUR_LOGIN%" LOGIN
call :prompt_password "eRepublik password" "%CUR_PASSWORD%" PASSWORD
call :prompt "Account label" "%CUR_SLUG%" SLUG

echo.
echo --- Daily actions ---
call :prompt "Maximum Q1 food price" "%CUR_MAX_FOOD%" MAX_FOOD

echo.
echo --- Gold farming (always on; tuned by weekly fuel budget) ---
call :prompt "Max travel cost per battle hop, in CC" "%CUR_FARM_MAX_CC%" FARM_MAX_CC
call :prompt "Minimum fuel barrels to keep in inventory" "%CUR_FARM_MIN_FUEL%" FARM_MIN_FUEL

:blocked_prompt
echo.
echo Blocked countries (names or IDs, comma-separated; e.g. "Poland, Romania, 33")
echo Type 'list' to see all available countries, blank for none.
set "BLOCKED_RAW=%CUR_FARM_BLOCKED_CSV%"
set /p "BLOCKED_RAW=> "
if /i "!BLOCKED_RAW!"=="list" (
    node\node.exe app\dist\util\resolveCountriesCli.js --list
    echo.
    goto blocked_prompt
)
if defined BLOCKED_RAW (
    if not "!BLOCKED_RAW!"=="" (
        for /f "delims=" %%r in ('node\node.exe app\dist\util\resolveCountriesCli.js "!BLOCKED_RAW!" 2^>nul') do set "FARM_BLOCKED_CSV=%%r"
        if errorlevel 1 (
            node\node.exe app\dist\util\resolveCountriesCli.js "!BLOCKED_RAW!"
            echo Please try again.
            goto blocked_prompt
        )
    )
)

echo.
echo --- Auto return-home ---
call :prompt "Return home after how many minutes abroad (0 disables)" "%CUR_RETURN_HOME_MIN%" RETURN_HOME_MIN
call :prompt "Max return-home travel cost" "%CUR_RETURN_HOME_MAX_CC%" RETURN_HOME_MAX_CC

echo.
echo --- Telegram notifications (optional) ---
echo Press Enter twice to skip Telegram setup.
call :prompt "Telegram bot token" "%CUR_TG_TOKEN%" TG_TOKEN
call :prompt "Telegram chat ID" "%CUR_TG_CHAT%" TG_CHAT

echo.
echo --- Captcha solver (optional) ---
call :prompt "Captcha provider [none/2captcha]" "%CUR_CAPTCHA%" CAPTCHA
if /i "!CAPTCHA!"=="2captcha" (
    call :prompt "2captcha API key" "%CUR_CAPTCHA_KEY%" CAPTCHA_KEY
)

echo.
echo Writing %ENVFILE%...

(
    echo ERP_LOGIN=!LOGIN!
    echo ERP_PASSWORD=!PASSWORD!
    echo ERP_ACCOUNT_SLUG=!SLUG!
    echo ERP_MAX_FOOD_PRICE=!MAX_FOOD!
    echo HEADED=false
    echo LOOP_INTERVAL_MS=600000
    echo ERP_FARM_MAX_TRAVEL_CC=!FARM_MAX_CC!
    echo ERP_FARM_MIN_FUEL=!FARM_MIN_FUEL!
    if defined FARM_BLOCKED_CSV echo ERP_FARM_BLOCKED_COUNTRIES=!FARM_BLOCKED_CSV!
    echo ERP_RETURN_HOME_AFTER_MINUTES=!RETURN_HOME_MIN!
    echo ERP_RETURN_HOME_MAX_CC=!RETURN_HOME_MAX_CC!
    if defined TG_TOKEN echo TELEGRAM_BOT_TOKEN=!TG_TOKEN!
    if defined TG_CHAT echo TELEGRAM_CHAT_ID=!TG_CHAT!
    echo ERP_CAPTCHA_PROVIDER=!CAPTCHA!
    if defined CAPTCHA_KEY echo ERP_CAPTCHA_API_KEY=!CAPTCHA_KEY!
) > "%TMPFILE%"

move /y "%TMPFILE%" "%ENVFILE%" >nul

echo OK.
echo.
echo Next step: double-click bootstrap.bat to log in to eRepublik.
echo.
pause
exit /b 0

:prompt
:: %1 = prompt text, %2 = default, %3 = output var name
set "_VAL=%~2"
set /p "_VAL=%~1 [%~2]: "
endlocal & set "%~3=%_VAL%"
setlocal enabledelayedexpansion
goto :eof

:prompt_password
:: Use PowerShell to read masked input. Default visible in prompt.
set "_DEFAULT=%~2"
if "%_DEFAULT%"=="" (
    set "_LABEL=%~1"
) else (
    set "_LABEL=%~1 [press Enter to keep current]"
)
for /f "delims=" %%a in ('powershell -NoProfile -Command "$p = Read-Host -AsSecureString '!_LABEL!'; $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($b)"') do set "_VAL=%%a"
if "%_VAL%"=="" set "_VAL=%_DEFAULT%"
endlocal & set "%~3=%_VAL%"
setlocal enabledelayedexpansion
goto :eof
```

- [ ] **Step 2: Create `windows/bootstrap.bat`**

```batch
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)

set ERP_ROOT=%~dp0
set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set HEADED=true

if not exist chromium-cache mkdir chromium-cache

dir /b /a:d chromium-cache\chromium-* >nul 2>&1
if errorlevel 1 (
    echo.
    echo ==========================================================
    echo   First-time setup: downloading CloakBrowser Chromium
    echo   ~200 MB, typically 3-5 minutes on a fast connection.
    echo   This happens once per install.
    echo ==========================================================
    echo.
    node\node.exe app\node_modules\cloakbrowser\dist\cli.js install
    if errorlevel 1 (
        echo.
        echo ERROR: Failed to download CloakBrowser Chromium.
        echo Check your internet connection. If you are behind a
        echo corporate firewall or VPN, see README.txt "Troubleshooting".
        pause
        exit /b 1
    )
    echo.
    echo Chromium download complete. Proceeding to login.
    echo.
)

node\node.exe app\dist\bootstrap.js
if errorlevel 1 (
    echo.
    echo Login failed. See logs\bootstrap.log for details.
    pause
    exit /b 1
)

echo.
echo Login successful. Double-click start.bat to begin.
pause
endlocal
exit /b 0
```

- [ ] **Step 3: Create `windows/start.bat`**

```batch
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)

dir /b /a:d chromium-cache\chromium-* >nul 2>&1
if errorlevel 1 (
    echo Chromium not installed yet. Please run bootstrap.bat first.
    pause
    exit /b 1
)

set ERP_ROOT=%~dp0
set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set ERP_FILE_LOGGING=true

echo Starting erepublik-agent. Close this window to stop the bot,
echo or double-click stop.bat. Logs: logs\agent-YYYY-MM-DD.log
echo.

node\node.exe app\dist\agent\runner.js

endlocal
```

- [ ] **Step 4: Create `windows/stop.bat`**

```batch
@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist logs\agent.pid (
    echo No running agent found.
    pause
    exit /b 0
)

set /p PID=<logs\agent.pid
taskkill /PID %PID% /F >nul 2>&1
del logs\agent.pid >nul 2>&1
echo Agent stopped (PID %PID%).
pause
endlocal
exit /b 0
```

- [ ] **Step 5: Create a stub `windows/README.txt`**

Full content lands in Task 8. For now, ship a placeholder so the artifact has the file:

```
erepublik-agent — Windows portable build

Quick start:
  1. Double-click setup.bat to configure your account.
  2. Double-click bootstrap.bat to log in to eRepublik.
  3. Double-click start.bat to run the bot.

Full instructions and troubleshooting come with the released ZIP.
```

- [ ] **Step 6: Convert line endings to CRLF**

```bash
for f in windows/setup.bat windows/bootstrap.bat windows/start.bat windows/stop.bat windows/README.txt; do
  sed -i.bak 's/$/\r/' "$f" && rm "$f.bak"
done
```

Verify:

```bash
file windows/*.bat
```

Expected: each `.bat` reports `ASCII text, with CRLF line terminators` (or similar).

- [ ] **Step 7: Commit**

```bash
git add windows/
git commit -m "feat: Windows .bat launchers (setup, bootstrap, start, stop)

setup.bat is an interactive English wizard that writes config/.env.
bootstrap.bat downloads CloakBrowser Chromium on first run (no-op
on subsequent runs) and then opens the headed login browser.
start.bat runs the agent with ERP_FILE_LOGGING=true. stop.bat
taskkills the process via logs/agent.pid.

Country names in setup.bat's blocked-countries prompt are resolved
via app/dist/util/resolveCountriesCli.js."
```

---

## Task 6: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release-windows.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Release (Windows portable)

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:

jobs:
  build-and-release:
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - name: Install all dependencies
        run: npm ci

      - name: Build TypeScript
        run: npm run build

      - name: Run unit tests
        run: npm test

      - name: Determine version
        id: version
        shell: pwsh
        run: |
          $tag = "${{ github.ref_name }}"
          $version = $tag -replace '^v', ''
          if (-not $version) { $version = "0.0.0-dev" }
          "version=$version" >> $env:GITHUB_OUTPUT

      - name: Download portable Node 22
        shell: pwsh
        run: |
          $url = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip"
          Invoke-WebRequest -Uri $url -OutFile node-portable.zip
          Expand-Archive -Path node-portable.zip -DestinationPath node-portable
          $nodeDir = (Get-ChildItem node-portable | Where-Object { $_.PSIsContainer } | Select-Object -First 1).FullName
          New-Item -ItemType Directory -Path staging\node | Out-Null
          Copy-Item "$nodeDir\node.exe" -Destination staging\node\

      - name: Stage compiled app
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Path staging\app -Force | Out-Null
          Copy-Item -Recurse dist staging\app\dist
          New-Item -ItemType Directory -Path staging\app\data -Force | Out-Null
          Copy-Item data\countries.json staging\app\data\
          Copy-Item package.json staging\app\
          Copy-Item package-lock.json staging\app\

      - name: Install production dependencies into staging
        shell: pwsh
        working-directory: staging\app
        run: npm ci --omit=dev

      - name: Stage Windows launcher files and empty dirs
        shell: pwsh
        run: |
          Copy-Item -Recurse windows\* staging\
          New-Item -ItemType Directory -Path staging\chromium-cache -Force | Out-Null
          New-Item -ItemType Directory -Path staging\sessions -Force | Out-Null
          New-Item -ItemType Directory -Path staging\logs -Force | Out-Null
          New-Item -ItemType Directory -Path staging\config -Force | Out-Null
          New-Item -ItemType File -Path staging\chromium-cache\.gitkeep -Force | Out-Null
          New-Item -ItemType File -Path staging\sessions\.gitkeep -Force | Out-Null
          New-Item -ItemType File -Path staging\logs\.gitkeep -Force | Out-Null
          New-Item -ItemType File -Path staging\config\.gitkeep -Force | Out-Null
          Set-Content -Path staging\app\VERSION -Value "${{ steps.version.outputs.version }}"

      - name: Create release ZIP
        shell: pwsh
        run: |
          $zipName = "erepublik-agent-v${{ steps.version.outputs.version }}-windows-x64.zip"
          # Compress the *contents* of staging\ under a top-level "erepublik-agent\" folder.
          Rename-Item staging "erepublik-agent"
          Compress-Archive -Path "erepublik-agent" -DestinationPath $zipName
          "zip=$zipName" >> $env:GITHUB_ENV

      - name: Upload artifact (for workflow_dispatch runs)
        uses: actions/upload-artifact@v4
        with:
          name: erepublik-agent-windows
          path: ${{ env.zip }}

      - name: Publish to GitHub Release (tag runs only)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: ${{ env.zip }}
          generate_release_notes: true
```

- [ ] **Step 2: Validate the YAML locally**

```bash
# If you have actionlint installed:
actionlint .github/workflows/release-windows.yml

# Otherwise just confirm it parses:
python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/release-windows.yml'))"
```

Expected: no errors / valid YAML.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-windows.yml
git commit -m "ci: GitHub Actions workflow for Windows portable release

On v*.*.* tag push, builds the TypeScript, runs tests, downloads
portable Node 22 (Windows x64), stages app/dist + production
node_modules + countries.json + .bat launchers, ZIPs as
erepublik-agent-vX.Y.Z-windows-x64.zip, and uploads to the GitHub
Release. workflow_dispatch is available for dry-run smoke tests."
```

- [ ] **Step 4: Smoke-test the workflow (no tag yet)**

Push the branch (or merge to main, depending on your workflow), then in the GitHub UI go to "Actions" → "Release (Windows portable)" → "Run workflow" on the appropriate branch. After ~10 minutes verify:

- All steps green.
- The `erepublik-agent-windows` artifact under the run is downloadable (~50 MB).
- Downloading and extracting it locally shows the expected tree (node/, app/, windows/.bat files, empty chromium-cache/sessions/logs/config dirs).

Document any failures and fix before proceeding.

---

## Task 7: End-to-end acceptance test on Windows

**Files:**
- Modify: `docs/superpowers/plans/2026-05-16-windows-distribution.md` (this plan) to record the test results inline.

This task is **manual** — no code changes. Skip if you do not have a Windows machine or VM available; flag as a blocker on the implementation PR.

- [ ] **Step 1: Provision a fresh Windows 11 environment**

Use UTM (macOS host), VirtualBox, VMware, or a friend's loaner. Install Windows 11 x64 from the official ISO. Set up a non-admin user account to mirror the target audience.

- [ ] **Step 2: Download the test artifact**

Either:
- Trigger a `workflow_dispatch` of the release workflow, download the artifact ZIP, transfer to the VM, OR
- Cut a real prerelease tag like `v0.0.1-rc.1` and download from GitHub Releases.

- [ ] **Step 3: Extract**

In Windows Explorer, right-click → "Extract All…" → choose Desktop. Verify the tree matches `erepublik-agent/{node,app,windows files…}`.

- [ ] **Step 4: Run setup.bat**

Double-click. Walk through every prompt. Test:
- Default values (press Enter to accept).
- A blocked-countries input like `Poland, Argentina, 33`. Verify the resolver succeeds.
- A blocked-countries input with a typo like `Polnd`. Verify the suggestion appears and the prompt is re-asked.
- The `list` command. Verify the three-column country table prints.

Open `config\.env` in Notepad. Verify all expected keys are present with sensible values.

- [ ] **Step 5: Run bootstrap.bat (first time)**

Double-click. Expected:
- "First-time setup: downloading CloakBrowser Chromium" banner.
- Progress indicator (cloakbrowser CLI's own output).
- After download, a Chromium window opens to the eRepublik login page.
- Sign in manually. The window closes automatically.
- "Login successful. Double-click start.bat to begin."

Verify `chromium-cache\chromium-<version>\` exists with Chromium binaries inside.

- [ ] **Step 6: Run bootstrap.bat (second time)**

Double-click again. Expected:
- No "downloading Chromium" banner — the script skips straight to login.
- Already-logged-in detection kicks in OR a fresh login is requested.

- [ ] **Step 7: Run start.bat**

Double-click. Expected:
- Console window stays open.
- Cycle logs print (`[cycle] starting`, etc.).
- `logs\agent.pid` is created.
- `logs\agent-YYYY-MM-DD.log` accumulates output.

Leave running for one full LOOP_INTERVAL_MS (default 10 minutes) and verify a second cycle runs.

- [ ] **Step 8: Run stop.bat**

Double-click while start.bat's window is still open. Expected:
- "Agent stopped (PID NNNN)."
- start.bat's window may or may not close cleanly (taskkill /F).
- `logs\agent.pid` is deleted.

- [ ] **Step 9: Overnight soak test**

Re-run start.bat, minimize the window, leave overnight (≥8 hours). Next morning verify:
- Process still alive (`tasklist | findstr node` in cmd).
- Log file shows continued cycle output.
- Daily/weekly state JSONs in `sessions/` are up to date.
- If Telegram is configured, the digest message arrived.

- [ ] **Step 10: Update plan inline**

Edit this section of the plan to record:
- Date of the test.
- Windows build (`winver`).
- Pass/fail per step.
- Any unexpected behavior (SmartScreen prompts, AV reports, etc.).

- [ ] **Step 11: Commit the recorded results**

```bash
git add docs/superpowers/plans/2026-05-16-windows-distribution.md
git commit -m "docs: record E2E acceptance test results for Windows ZIP"
```

---

## Task 8: Final README, Telegram release post, and tagging

**Files:**
- Modify: `windows/README.txt`
- Create: `docs/superpowers/releases/2026-05-16-windows-v1.md` (Telegram post draft)

- [ ] **Step 1: Replace the stub `windows/README.txt`**

Overwrite the stub from Task 5 with the full plain-text README. ≤80 lines.

```
erepublik-agent — Windows portable build
==========================================

What this is
------------
A bot for eRepublik that performs your daily actions (work, train,
buy food, claim missions) and runs gold-farming sessions across
empty-division battles, automatically. Runs in the background; you
configure once and forget.

System requirements
-------------------
- Windows 10 or 11, 64-bit.
- ~500 MB free disk space (50 MB ZIP + 200 MB Chromium download).
- A working internet connection during first bootstrap.
- No admin rights needed.

Quick start
-----------
1. Extract this ZIP anywhere. Desktop is fine.
2. Double-click setup.bat.
   You will be asked for your eRepublik login, password, and a few
   tuning options. Press Enter to accept any default.
3. Double-click bootstrap.bat.
   The first run downloads CloakBrowser Chromium (~200 MB, 3-5 min).
   A browser window then opens at the eRepublik login page — sign in
   manually. The window closes automatically once you're logged in.
4. Double-click start.bat.
   The bot starts running. Minimize the window. Done.

Stopping the bot
----------------
- Double-click stop.bat, OR
- Close the start.bat console window directly.

Logs
----
Every cycle is logged to logs\agent-YYYY-MM-DD.log. If something
breaks and you need help, send the most recent log file.

Updating
--------
Download the new ZIP, extract over the existing folder. Your
sessions\ and config\ contents are preserved.

Troubleshooting
---------------
1. "Windows protected your PC" SmartScreen warning
   Click "More info" → "Run anyway". The .bat files are not signed.

2. bootstrap.bat fails during Chromium download
   Your network is blocking the CloakBrowser CDN. If you're on
   corporate Wi-Fi or VPN, switch to a personal network for the
   first bootstrap. Once chromium-cache\ is populated, network
   restrictions don't matter for normal runs (only eRepublik and
   optionally Telegram are contacted).

3. Antivirus quarantines chromium-cache\...\chrome.exe
   Add the install folder to your antivirus exclusion list.

4. Login screen reappears every day
   Session expired. Rerun bootstrap.bat. Chromium does NOT
   re-download — only the login is repeated.

5. "No running agent found." when running stop.bat
   The bot wasn't running. Use Task Manager to check.

Disclaimer
----------
Automation against an online game violates eRepublik Terms of
Service. Use at your own risk. We cannot guarantee your account
will not be sanctioned. There is no telemetry — your credentials
never leave your machine.
```

- [ ] **Step 2: Convert README to CRLF line endings**

```bash
sed -i.bak 's/$/\r/' windows/README.txt && rm windows/README.txt.bak
file windows/README.txt
```

Expected: `ASCII text, with CRLF line terminators`.

- [ ] **Step 3: Draft the Telegram release announcement**

Create `docs/superpowers/releases/2026-05-16-windows-v1.md` (this is a draft template the maintainer copies into Telegram on release day, not a published artifact):

```markdown
# Telegram release post — v1.0.0 (Windows portable)

> Subject to edits. Post the body below to the Telegram channel along with the ZIP attachment.

---

🚀 *erepublik-agent v1.0.0 — Windows release*

What's new:
• Portable ZIP for Windows — no Docker, no Node.js install, no terminal
• Three .bat files: setup → bootstrap → start
• Country names work in the blocked-countries prompt (74 countries supported)
• Per-install logging to logs/agent-YYYY-MM-DD.log for easier support

Install:
1. Download the ZIP attached.
2. Extract anywhere.
3. Run setup.bat, then bootstrap.bat, then start.bat.

Full instructions in README.txt inside the ZIP.

⚠️ This bot violates eRepublik ToS. Use at your own risk. Your credentials never leave your machine.

🐛 Bug reports: send the latest file from your logs\ folder.
```

- [ ] **Step 4: Verify the final artifact looks right**

Trigger one more `workflow_dispatch` of the release workflow. Download the artifact. Confirm `README.txt` is the full version and that the staging tree matches expectations.

- [ ] **Step 5: Commit**

```bash
git add windows/README.txt docs/superpowers/releases/
git commit -m "docs: final README and Telegram release post template for v1"
```

- [ ] **Step 6: Cut the v1.0.0 tag**

```bash
git tag -a v1.0.0 -m "v1.0.0: first Windows portable release"
git push origin v1.0.0
```

The GitHub Actions workflow fires automatically. After ~10 minutes, verify the GitHub Release page has the ZIP attached.

- [ ] **Step 7: Post to Telegram**

Open Telegram, paste the body from `docs/superpowers/releases/2026-05-16-windows-v1.md` into the channel, attach the ZIP from the GitHub Release. Done.

---

## Acceptance criteria for "the plan is done"

- [ ] `npm run build` produces a working `dist/` and `node dist/agent/runner.js` runs identically to `npm run agent`.
- [ ] `npm test` runs 12+ tests for `resolveCountries`, all pass.
- [ ] `ERP_ROOT=/some/path npm run agent` writes sessions/logs to `/some/path`, not the repo.
- [ ] Tagging `v1.0.0` produces a GitHub Release with a ~50 MB ZIP attached.
- [ ] On a fresh Windows VM, the user can go from "ZIP downloaded" to "bot running" using only mouse clicks (no PowerShell, no Notepad).
- [ ] After overnight run, the daily/weekly state JSONs in `sessions/` are valid and a Telegram digest (if configured) was delivered.
