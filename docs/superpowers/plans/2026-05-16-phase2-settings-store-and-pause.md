# Phase 2 — Settings Store + Pause/Farm Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `config/settings.json` as the editable runtime config, plus two boolean gates (`paused`, `farmEnabled`) that the runner reads every cycle so the user can pause the bot or just the farming part without restarting.

**Architecture:** New `src/ui/settingsStore.ts` defines a Zod schema for the full settings shape (matching spec §4.1), implements `loadSettings()` with first-run migration from `.env` defaults, and `saveSettings()` with atomic write-temp-rename. `runner.ts` calls `loadSettings()` at the top of each cycle, short-circuits when `paused`, and skips the farm gate when `!farmEnabled`. Tests live in `src/ui/settingsStore.test.ts` (vitest). Per project convention, no UI yet — that's Phase 3.

**Tech Stack:** Node 22, TypeScript via `tsx` (no build step). Zod for schema validation. Vitest for unit tests (already wired — see `src/util/resolveCountries.test.ts` for an existing example).

**Spec:** `docs/superpowers/specs/2026-05-16-flexible-farming-config-design.md` (§4 Settings store, §5.4 security)

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/ui/settingsStore.ts` | **create** | Zod schema, `DEFAULT_SETTINGS` const, `loadSettings()` (with first-run migration), `saveSettings()` (atomic). One responsibility: persist + parse `config/settings.json`. |
| `src/ui/settingsStore.test.ts` | **create** | Vitest tests: schema parse, migration from `.env`, malformed-file behavior, save+reload roundtrip, atomic-write verification. |
| `src/agent/runner.ts` | modify | Read settings at the top of `runCycle`. Gate the cycle body on `paused`. Gate the farm block on `farmEnabled`. The existing `.env`-derived `ERP_RETURN_HOME_AFTER_MINUTES` / `ERP_RETURN_HOME_MAX_CC` keep working as fallbacks but the runner prefers `settings.travel.*` when present. |
| `src/paths.ts` | unchanged | `configDir()` already exists and `mkdirs()` on access — `settings.json` lives next to `.env`. |

The settings module does not export anything UI-related; it's named `src/ui/` per spec §1.2 only because Phase 3 will add the HTTP server in the same directory. Phase 2 is purely data-layer.

---

## Task 1: Define schema and defaults

**Files:**
- Create: `src/ui/settingsStore.ts` (schema-only, no functions yet)

The full Zod schema mirrors spec §4.1. The `detected` object is runtime-populated by the runner (Phase 5+); for Phase 2 the defaults are all `null`.

- [ ] **Step 1: Create the file with schema + types + defaults**

```ts
import { z } from 'zod';

// ── Schema (matches spec §4.1) ──────────────────────────────────────────────

const StrategyId = z.enum(['standard', 'd4tw', 'maverickD3']);

const D4TWSettings = z.object({
  targetDamageAttacker: z.number().int().positive().default(130_000_000),
  targetDamageDefender: z.number().int().positive().default(220_000_000),
  maxBattlesPerSession: z.number().int().min(1).max(10).default(1),
  weaponPriority: z.array(z.number().int().min(1).max(7)).default([7, 6, 5, 4, 3, 2, 1]),
});

const EmptyDivSettings = z.object({
  maxBattlesPerSession: z.number().int().min(1).max(10).default(3),
  nativeWeaponPriority: z.array(z.number().int().min(1).max(7)).default([7, 6, 5, 4, 3, 2, 1]),
  foreignWeaponPolicy: z.enum(['bomb-then-bazooka', 'no-weapon']).default('bomb-then-bazooka'),
});

const TravelSettings = z.object({
  maxTravelCC: z.number().int().nonnegative().default(100),
  returnHomeAfterMinutes: z.number().int().min(0).default(15),
  returnHomeMaxCC: z.number().int().positive().default(500),
});

const DetectedState = z.object({
  division: z.number().int().nullable().default(null),
  hasMaverick: z.boolean().nullable().default(null),
  citizenId: z.number().int().nullable().default(null),
  countryId: z.number().int().nullable().default(null),
  lastUpdated: z.string().nullable().default(null),
});

export const Settings = z.object({
  paused: z.boolean().default(false),
  farmEnabled: z.boolean().default(true),
  modeOverride: StrategyId.nullable().default(null),
  maverickManual: z.boolean().nullable().default(null),
  d4tw: D4TWSettings.default({}),
  emptyDiv: EmptyDivSettings.default({}),
  travel: TravelSettings.default({}),
  detected: DetectedState.default({}),
});

export type Settings = z.infer<typeof Settings>;

/** Fully-defaulted settings object. Used as fallback when no file exists. */
export const DEFAULT_SETTINGS: Settings = Settings.parse({});
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ui/settingsStore.ts
git commit -m "feat(settings): define Zod schema for config/settings.json"
```

---

## Task 2: Implement `loadSettings()` with first-run migration

**Files:**
- Modify: `src/ui/settingsStore.ts`
- Create: `src/ui/settingsStore.test.ts`

TDD: write tests first, run to confirm failure, then implement.

- [ ] **Step 1: Add tests for load (TDD red phase)**

Create `src/ui/settingsStore.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settingsStore.js';

describe('settingsStore', () => {
  let tmpRoot: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'erp-settings-'));
    originalRoot = process.env.ERP_ROOT;
    process.env.ERP_ROOT = tmpRoot;
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.ERP_ROOT;
    else process.env.ERP_ROOT = originalRoot;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('creates default settings file on first run', () => {
      const settings = loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
      expect(existsSync(join(tmpRoot, 'config', 'settings.json'))).toBe(true);
    });

    it('returns previously saved settings on subsequent runs', () => {
      const first = loadSettings();
      const file = join(tmpRoot, 'config', 'settings.json');
      const written = JSON.parse(readFileSync(file, 'utf8'));
      written.paused = true;
      writeFileSync(file, JSON.stringify(written, null, 2));

      const second = loadSettings();
      expect(second.paused).toBe(true);
      expect(first.paused).toBe(false);
    });

    it('migrates ERP_RETURN_HOME_AFTER_MINUTES from .env on first run', () => {
      process.env.ERP_RETURN_HOME_AFTER_MINUTES = '7';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeAfterMinutes).toBe(7);
      } finally {
        delete process.env.ERP_RETURN_HOME_AFTER_MINUTES;
      }
    });

    it('migrates ERP_FARM_MAX_TRAVEL_CC from .env on first run', () => {
      process.env.ERP_FARM_MAX_TRAVEL_CC = '250';
      try {
        const settings = loadSettings();
        expect(settings.travel.maxTravelCC).toBe(250);
      } finally {
        delete process.env.ERP_FARM_MAX_TRAVEL_CC;
      }
    });

    it('migrates ERP_RETURN_HOME_MAX_CC from .env on first run', () => {
      process.env.ERP_RETURN_HOME_MAX_CC = '1000';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeMaxCC).toBe(1000);
      } finally {
        delete process.env.ERP_RETURN_HOME_MAX_CC;
      }
    });

    it('ignores .env values once settings.json exists', () => {
      loadSettings(); // creates default file with returnHomeAfterMinutes=15
      process.env.ERP_RETURN_HOME_AFTER_MINUTES = '99';
      try {
        const settings = loadSettings();
        expect(settings.travel.returnHomeAfterMinutes).toBe(15);
      } finally {
        delete process.env.ERP_RETURN_HOME_AFTER_MINUTES;
      }
    });

    it('throws on malformed JSON rather than silently using defaults', () => {
      const file = join(tmpRoot, 'config', 'settings.json');
      loadSettings(); // create dir
      writeFileSync(file, 'not valid json {');
      expect(() => loadSettings()).toThrow();
    });

    it('throws on schema mismatch rather than silently using defaults', () => {
      const file = join(tmpRoot, 'config', 'settings.json');
      loadSettings();
      writeFileSync(file, JSON.stringify({ paused: 'yes please' }));
      expect(() => loadSettings()).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm test --silent -- settingsStore`
Expected: All tests FAIL with `loadSettings is not a function` or `Cannot find module`.

- [ ] **Step 3: Implement `loadSettings()`**

Append to `src/ui/settingsStore.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../paths.js';

function filePath(): string {
  return join(configDir(), 'settings.json');
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the initial settings object on first run, sourcing migrated values
 * from .env when present. Keys not in .env fall through to schema defaults.
 */
function buildInitial(): Settings {
  return Settings.parse({
    travel: {
      maxTravelCC: envNum('ERP_FARM_MAX_TRAVEL_CC', 100),
      returnHomeAfterMinutes: envNum('ERP_RETURN_HOME_AFTER_MINUTES', 15),
      returnHomeMaxCC: envNum('ERP_RETURN_HOME_MAX_CC', 500),
    },
  });
}

export function loadSettings(): Settings {
  const file = filePath();
  if (!existsSync(file)) {
    const initial = buildInitial();
    writeFileSync(file, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return Settings.parse(raw);
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test --silent -- settingsStore`
Expected: All `loadSettings` tests PASS. `saveSettings` tests skipped/error (not implemented yet).

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settingsStore.ts src/ui/settingsStore.test.ts
git commit -m "feat(settings): loadSettings with first-run migration from .env"
```

---

## Task 3: Implement `saveSettings()` with atomic write

**Files:**
- Modify: `src/ui/settingsStore.ts`
- Modify: `src/ui/settingsStore.test.ts`

The spec requires atomic writes (write to a temp file, then rename) so the UI's PUT in Phase 4 cannot tear-read a half-written file.

- [ ] **Step 1: Add saveSettings tests (TDD red)**

Append inside the outer `describe('settingsStore', () => { ... })` block in `src/ui/settingsStore.test.ts`, after the `loadSettings` describe:

```ts
  describe('saveSettings', () => {
    it('persists changes that loadSettings later reads', () => {
      const first = loadSettings();
      first.paused = true;
      first.d4tw.targetDamageAttacker = 150_000_000;
      saveSettings(first);

      const second = loadSettings();
      expect(second.paused).toBe(true);
      expect(second.d4tw.targetDamageAttacker).toBe(150_000_000);
    });

    it('rejects payloads that fail schema validation', () => {
      const s = loadSettings();
      // @ts-expect-error — intentional invalid value
      s.paused = 'yes';
      expect(() => saveSettings(s)).toThrow();
    });

    it('does not leave a temp file behind on success', () => {
      const s = loadSettings();
      saveSettings(s);
      // Temp file uses `.tmp` suffix; final file is settings.json
      const dirContents = readFileSync(join(tmpRoot, 'config', 'settings.json'), 'utf8');
      expect(dirContents.length).toBeGreaterThan(0);
      const tmpFile = join(tmpRoot, 'config', 'settings.json.tmp');
      expect(existsSync(tmpFile)).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `npm test --silent -- settingsStore`
Expected: `saveSettings is not a function` errors on the new describe block.

- [ ] **Step 3: Implement saveSettings**

Append to `src/ui/settingsStore.ts`:

```ts
import { renameSync } from 'node:fs';

/**
 * Atomic write: serialize to a temp file then rename over the target.
 * Rename is atomic on POSIX and Windows NTFS, so a concurrent reader either
 * sees the old file or the new one — never a torn write.
 */
export function saveSettings(settings: Settings): void {
  const validated = Settings.parse(settings);
  const file = filePath();
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(validated, null, 2), 'utf8');
  renameSync(tmp, file);
}
```

The `renameSync` import can be added to the existing `node:fs` import line.

- [ ] **Step 4: Run tests to confirm pass**

Run: `npm test --silent -- settingsStore`
Expected: All tests PASS (load + save).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settingsStore.ts src/ui/settingsStore.test.ts
git commit -m "feat(settings): saveSettings with atomic temp-rename"
```

---

## Task 4: Wire `paused` gate into runner

**Files:**
- Modify: `src/agent/runner.ts`

When `settings.paused === true`, the cycle reads citizen context (so we can detect unpause + keep the captcha gate working) but skips all actions, farm gate, sweeps, and digest.

- [ ] **Step 1: Add import**

After the existing imports in `src/agent/runner.ts` (around line 31, near `getStrategy`), add:

```ts
import { loadSettings } from '../ui/settingsStore.js';
```

- [ ] **Step 2: Load settings at the top of `runCycle`**

Find the line near the start of `runCycle` (right after `const { state: fuel, rolledOver: fuelRolled } = loadFuel();`) and add:

```ts
  const settings = loadSettings();
  if (settings.paused) {
    console.log('[cycle] paused — skipping (toggle in config/settings.json or UI)');
    return;
  }
```

This goes BEFORE the `extractCitizenContext` call so a paused bot doesn't even hit the page. Note: this means CSRF refreshes pause too. That's acceptable — when the user unpauses, the next cycle re-extracts everything.

- [ ] **Step 3: Manual sanity check**

Create a minimal settings file and confirm the gate fires:

```bash
mkdir -p config && echo '{"paused":true,"farmEnabled":true,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}' > config/settings.json
```

Run a one-shot cycle:

```bash
timeout 30 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | head -50
```

Expected: `[cycle] paused — skipping...` appears, no `[cycle] api:` line, no farm activity. Then **remove** the manual settings file:

```bash
rm config/settings.json
```

Don't leave a paused state on disk for the next task.

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm test --silent`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): honor settings.paused — skip cycle body when true"
```

---

## Task 5: Wire `farmEnabled` gate into runner

**Files:**
- Modify: `src/agent/runner.ts`

When `settings.farmEnabled === false`, the cycle runs daily actions, sweeps, and the return-home logic, but never calls `runFarmSession`. The return-home code lives inside the `!decision.shouldFarm` branch — we keep that path active by forcing `decision.shouldFarm` to false when farming is disabled. Surgical: 1-line touch, no indentation changes.

- [ ] **Step 1: Force decision to disabled when toggle is off**

In `src/agent/runner.ts`, find the line:

```ts
    const decision = decideFarming({
      weekly: fuel,
      poolEnergy: ctxInfo.energy ?? 0,
      fuelInInventory: fuelAtCycleStart,
    });
```

Replace with:

```ts
    const decision = settings.farmEnabled
      ? decideFarming({
          weekly: fuel,
          poolEnergy: ctxInfo.energy ?? 0,
          fuelInInventory: fuelAtCycleStart,
        })
      : {
          shouldFarm: false as const,
          reason: 'disabled via settings.farmEnabled',
          battlesThisSession: 0,
          diagnostics: {
            target: 0,
            spent: fuel.spent,
            ahead: 0,
            remaining: 0,
            weekFraction: 0,
          },
        };
```

The existing log line `[cycle] farm: ${decision.shouldFarm ? '✅' : '⏭'} ${decision.reason} (week=...)` will print `⏭ disabled via settings.farmEnabled` when the toggle is off. Return-home logic in the `!decision.shouldFarm` branch keeps working because we set `shouldFarm: false`. The `cyclesSkipped++` line also fires (consistent with all other skip reasons).

- [ ] **Step 2: Manual sanity check**

Create a `farmEnabled: false` settings file:

```bash
mkdir -p config && cat > config/settings.json <<'EOF'
{"paused":false,"farmEnabled":false,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}
EOF
```

Run a one-shot cycle:

```bash
timeout 60 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | head -100
```

Expected: cycle runs through daily actions, then logs `[cycle] farm: ⏭ disabled via settings.farmEnabled (week=…)`. No `runFarmSession` call. Return-home is still considered (it would fire if conditions match).

Remove the file:

```bash
rm config/settings.json
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test --silent`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): honor settings.farmEnabled — skip farm session when false"
```

- [ ] **Step 2: Manual sanity check**

Create a `farmEnabled: false` settings file:

```bash
mkdir -p config && cat > config/settings.json <<'EOF'
{"paused":false,"farmEnabled":false,"modeOverride":null,"maverickManual":null,"d4tw":{"targetDamageAttacker":130000000,"targetDamageDefender":220000000,"maxBattlesPerSession":1,"weaponPriority":[7,6,5,4,3,2,1]},"emptyDiv":{"maxBattlesPerSession":3,"nativeWeaponPriority":[7,6,5,4,3,2,1],"foreignWeaponPolicy":"bomb-then-bazooka"},"travel":{"maxTravelCC":100,"returnHomeAfterMinutes":15,"returnHomeMaxCC":500},"detected":{"division":null,"hasMaverick":null,"citizenId":null,"countryId":null,"lastUpdated":null}}
EOF
```

Run a one-shot cycle:

```bash
timeout 60 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | head -100
```

Expected: cycle runs through daily actions, then logs `[cycle] farm: ⏭ disabled via settings.farmEnabled`, no `decideFarming` output, no `runFarmSession` call. Then remove the file:

```bash
rm config/settings.json
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npm test --silent`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(runner): honor settings.farmEnabled — skip farm gate when false"
```

---

## Task 6: Smoke-test Phase 2

**Files:** none modified — verification only.

- [ ] **Step 1: Default-settings smoke test**

Ensure `config/settings.json` does NOT exist (fresh run condition):

```bash
rm -f config/settings.json
```

Run a one-shot cycle:

```bash
timeout 60 env ERP_ACCOUNT_SLUG=baryga2026 npm run agent 2>&1 | head -100
```

Expected:
- `config/settings.json` is created during the cycle (verify with `cat config/settings.json | head -10` after).
- No `[cycle] paused` line (default `paused=false`).
- `[cycle] farm: …` line appears with normal Phase 1 wording (default `farmEnabled=true`).
- No regression vs. Phase 1 behavior.

- [ ] **Step 2: Run the farmer dry-run**

```bash
ERP_ACCOUNT_SLUG=baryga2026 npm run farmer 2>&1 | tail -30
```

Expected: identical output shape to Phase 1 smoke — `farmer` doesn't touch settings (it bypasses the runner's gate logic by design — operator-launched).

- [ ] **Step 3: Full vitest suite**

```bash
npm test --silent
```

Expected: all tests pass, including new `settingsStore` tests.

- [ ] **Step 4: Final tidy**

Remove any debug `config/settings.json` you created during manual testing. The file is gitignored so this is local-state hygiene only:

```bash
ls config/settings.json 2>/dev/null && echo "settings.json still present (ok)" || echo "no settings.json"
```

(Either outcome is fine — leaving the file is harmless; the next start regenerates it.)

- [ ] **Step 5: No commit**

This task is verification only.

---

## Self-Review Notes (for the implementer)

- Tasks 2 and 3 each follow TDD: write failing tests → implement → green. The existing repo only has one test file (`resolveCountries.test.ts`); this phase establishes the pattern that later phases (5, 6, 7) will reuse for `damageFormula`, `modeSelector`, etc.
- `Settings.parse({})` works because every top-level field has a `.default(...)`. If you add a non-defaulted field later, this call breaks — that's by design (forces explicit defaults).
- `DEFAULT_SETTINGS` is a frozen-shape snapshot; consumers should treat it as read-only.
- The `paused` gate must run BEFORE `extractCitizenContext` so we don't hammer the page when paused. The captcha handler still gets a chance — but only on the next un-paused cycle.
- Phase 3 will add HTTP GET `/api/settings`; Phase 4 adds PUT. Both call into the same `loadSettings` / `saveSettings` so the atomic-write guarantee covers them automatically.
- The runner does NOT yet use `settings.travel.*`, `settings.modeOverride`, etc. Those fields exist in the schema for Phase 5/6's use and to keep `settings.json`'s shape stable from day one. Don't refactor the existing `env.ERP_RETURN_HOME_AFTER_MINUTES` code path in this phase.
