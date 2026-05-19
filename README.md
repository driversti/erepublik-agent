# erepublik-agent

Browser-driving automation for eRepublik, built on **CloakBrowser** (stealth Chromium). The repo hosts **two cooperating workloads** that share the same browser profile, transport layer, and endpoint allow-list — but are otherwise independent:

| Workload | What it does | Entry points |
|---|---|---|
| **Daily runner** | Performs the safe-daily loop: `work`, `train`, buy 1 Q1 food, claim VIP, claim missions + AP chests + weekly challenge tiers. Long-running by default. | `npm start` / `npm run agent` |
| **Gold-farming pipeline** | Discovers empty-division battles, plans a cheapest-travel route, deploys on **both** sides to collect True Patriot / Freedom Fighter / Mercenary medals. | `npm run farmer`, `npm run farm-one`, `npm run farmable` |

Both workloads are fully **deterministic** — no LLM is on the hot path. Every decision (what to do, in what order, when to stop) is made by plain TypeScript reading local memory and API responses.

> Earlier versions ran the daily loop through Claude Haiku via the Claude Agent SDK + MCP tools. That was removed once it became clear the model was only executing a fixed recipe with no real reasoning — see `docs/superpowers/specs/2026-05-14-erepublik-agent-design.md` for the original design.

---

## Install (Windows)

1. Download `erepublik-agent-Setup-X.Y.Z-x64.exe` from the latest GitHub Release or Telegram channel.
2. Double-click the installer; choose any folder when prompted. No admin rights required.
3. The setup wizard opens. Fill in your eRepublik email/password and tuning options, sign in through the headed browser window that appears, then click "Start bot".
4. The app lives in your system tray. Left-click for the dashboard; right-click for Pause / Quit / Settings.

### Migrating from the old .bat distribution

The wizard's step 1 has a banner: "Already running the old ZIP version? Import existing setup →". Click it, point to your old folder, and your sessions/, config/, and chromium-cache/ are copied — no re-login, no Chromium re-download.

### Developer workflow

```bash
git clone <repo-url>
cd erepublik-agent
npm install
npm run bootstrap   # one-shot manual login
npm run agent       # one daily cycle
npm start           # long-running with dashboard
```

(Developer workflow is unchanged. The Electron build is the *user* distribution; developers keep using tsx.)

---

## Setup

```bash
cp .env.example .env
# Fill in: ERP_LOGIN, ERP_PASSWORD, ERP_MAX_FOOD_PRICE.
# Telegram, farming, and tuning vars are optional.

npm install
npm run bootstrap        # opens a visible browser, you log in once; profile persists
npm run healthcheck      # confirms the persisted session still authenticates
```

After `bootstrap`, the CloakBrowser profile lives in `sessions/profile/<ERP_ACCOUNT_SLUG>/` and is reused by every other script. Credentials are **only** read by `bootstrap.ts` — they are never touched again.

For a second account: set a different `ERP_ACCOUNT_SLUG`, re-run `bootstrap`, then point the agent / farmer at that slug.

### Running on Linux (headless server / LXC)

CloakBrowser ships its own Chromium binary, but it relies on system shared libraries that aren't present in minimal Linux installs (LXC templates, slim Docker images, fresh VPS). The first launch typically fails with:

```
error while loading shared libraries: libnspr4.so: cannot open shared object file
```

**Fix on Ubuntu / Debian:**

```bash
sudo apt update
sudo apt install -y \
  libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  libatspi2.0-0 libwayland-client0 fonts-liberation libu2f-udev
```

On Ubuntu 22.04 the package is `libasound2` (not `libasound2t64`).

Verify nothing is still missing:

```bash
ldd /home/<user>/.cloakbrowser/chromium-*/chrome | grep "not found"
```

Should print nothing.

**Headless bootstrap (no desktop on the server):** `bootstrap.ts` will fill the login form and submit automatically when `HEADED=false`. Put `ERP_LOGIN` / `ERP_PASSWORD` in `.env`, set `HEADED=false`, then run `npm run bootstrap`. The session is persisted in `sessions/profile/<slug>/` exactly the same way as a headed login.

> **Caveat:** if eRepublik shows a captcha **on the login form itself** (common from a brand-new datacentre IP), headless bootstrap can't pass it — `bootstrap.ts` only handles the in-game session-unlock captcha, not the login one. Workaround: run `HEADED=true npm run bootstrap` on your local desktop, then `scp -r sessions/profile/<slug>/` to the server. The profile is portable.

---

## Configuration

The bot reads its settings from **two separate files**. They serve different purposes:

| File | Where it lives | Edit when | Hot-reload? | What goes here |
|---|---|---|---|---|
| `.env` | Project root | Once, before first run | No — restart bot after changes | Login credentials, optional services (Telegram, captcha), one-time defaults |
| `config/settings.json` | `config/` folder | Any time | **Yes** — bot picks up changes within seconds | Live behavior: pause, strategy choice, damage targets, cooldown |

**Rule of thumb:** put secrets and one-time setup into `.env`. Put everything you might want to change while the bot is running into `config/settings.json`.

You don't have to edit `config/settings.json` by hand if you don't want to — once the bot is running, open the dashboard at **http://localhost:3737** and use the UI form. It writes the file for you.

---

### 1. `.env` — credentials and one-time setup

Stored at the project root. To create it: `cp .env.example .env`, then open it in any text editor and fill in the values.

**Important:** changes here take effect only on the next bot restart. If you want a setting you can change without restarting, set it in `config/settings.json` instead (most behavior knobs live there).

#### Required fields

| Variable | Example | What it does |
|---|---|---|
| `ERP_LOGIN` | `me@example.com` | Your eRepublik account email. Read **only** during `npm run bootstrap` — never sent anywhere except eRepublik's login form. |
| `ERP_PASSWORD` | `s3cret!` | Same. After bootstrap, the login session is stored in `sessions/profile/<slug>/`; the password is never read again. |
| `ERP_MAX_FOOD_PRICE` | `3.0` | Hard ceiling on Q1 food unit price. Bot refuses to buy above this. Typical Q1 prices are 0.5–2.0, so 3.0 is a safe margin. |

#### Multiple accounts

| Variable | Default | What it does |
|---|---|---|
| `ERP_ACCOUNT_SLUG` | `main` | Folder name under `sessions/profile/`. To run a second account, set a different slug (e.g. `alt`), re-run `npm run bootstrap`, and that profile is reused on subsequent runs. |

#### Telegram notifications (optional)

| Variable | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) on Telegram. Skip both fields if you don't want notifications — the bot still logs everything to the terminal. |
| `TELEGRAM_CHAT_ID` | Your personal chat ID (or a group ID). Get it from [@userinfobot](https://t.me/userinfobot). |

You'll get a digest after every cycle (only when something changed), plus per-battle messages when farming fires.

#### Captcha solver (optional)

When eRepublik shows its "click the lock" verification challenge, the bot can either alert you and skip the cycle, or pay a service to solve it automatically.

| Variable | Default | What it does |
|---|---|---|
| `ERP_CAPTCHA_PROVIDER` | `none` | `none` = detect, alert via Telegram, skip cycle. `2captcha` = auto-solve via api.2captcha.com (~$0.001 per solve). |
| `ERP_CAPTCHA_API_KEY` | (empty) | Required when `ERP_CAPTCHA_PROVIDER=2captcha`. Get it from the 2captcha dashboard. |
| `ERP_CAPTCHA_MAX_ATTEMPTS` | `10` | Retries before giving up on a challenge. |

#### Visibility & timing

| Variable | Default | What it does |
|---|---|---|
| `HEADED` | `false` | `true` opens a visible Chromium window so you can watch what the bot is doing. Useful when something looks wrong. |
| `LOOP_INTERVAL_MS` | `600000` | How long the bot sleeps between cycles, in milliseconds. `600000` = 10 minutes. Shorter = more checks but more load. |
| `ERP_UI_HOST` | `0.0.0.0` | Interface the UI dashboard binds to. Default reaches the whole LAN (handy when running in an LXC / headless server and opening the UI from your laptop). Set to `127.0.0.1` to restrict to loopback only. **The UI has no authentication** — keep it off the public internet; LAN-only or behind a reverse proxy with auth. |

#### Auto return-home

When farming sends the bot abroad, these control when it travels back to your residence.

| Variable | Default | What it does |
|---|---|---|
| `ERP_RETURN_HOME_AFTER_MINUTES` | `15` | Travel back after this many minutes abroad (only on idle cycles, so a farm trip isn't immediately undone). `0` disables. |
| `ERP_RETURN_HOME_MAX_CC` | `500` | Maximum local currency to spend on returning home. Pricier trips are skipped, with a Telegram alert. |

#### Country detection fallback

| Variable | Default | What it does |
|---|---|---|
| `ERP_COUNTRY_ID` | (auto) | Bot normally auto-detects your country. Set this only if detection fails for some reason. |

#### First-run-only seeds

These are read **once** to populate `config/settings.json` on the very first run. After that, edit `config/settings.json` (or use the dashboard) — changing them in `.env` later does nothing.

| Variable | Default | Seeds this field in settings.json |
|---|---|---|
| `ERP_SESSION_COOLDOWN_MIN_MIN` | `30` | `farmSession.cooldownMinMinutes` |
| `ERP_SESSION_COOLDOWN_MAX_MIN` | `90` | `farmSession.cooldownMaxMinutes` |
| `ERP_EMPTY_DIV_MAX_BATTLES_PER_SESSION` | `3` | `emptyDiv.maxBattlesPerSession` |
| `ERP_D4TW_MAX_BATTLES_PER_SESSION` | `1` | `d4tw.maxBattlesPerSession` |
| `ERP_FARM_MAX_TRAVEL_CC` | `100` | `travel.maxTravelCC` |

---

### 2. `config/settings.json` — live behavior config

This file is **created automatically** on the bot's first run, with sensible defaults. After that you can edit it whenever — the bot watches the file and applies changes within seconds, no restart needed.

Three ways to edit it:
1. **Easiest** — open the dashboard at http://localhost:3737 (once `npm start` is running), use the form, click Save.
2. **Direct edit** — open `config/settings.json` in any text editor, save the file.
3. **HTTP API** — `PUT /api/settings` with the new JSON (used by the dashboard internally).

All three are equivalent. The file write is atomic (tempfile + rename), so you'll never end up with a half-written settings file.

#### Top-level switches

```json
{
  "paused": false,
  "farmEnabled": true,
  "modeOverride": null,
  "maverickManual": null
}
```

| Field | Values | What it does |
|---|---|---|
| `paused` | `true` / `false` | When `true`, the bot does **nothing** — no clicks, no API calls, no battles. Use this if you want to log into the game manually without the bot getting in the way. |
| `farmEnabled` | `true` / `false` | When `false`, the bot still does daily chores (work, train, claim rewards) but skips the medal-farming step. |
| `modeOverride` | `null`, `"standard"`, `"d4tw"`, `"d4tw-air"`, `"maverickD3"` | Force a specific farming strategy. `null` (default) = auto-detect based on your division. See "Strategies" below. |
| `maverickManual` | `true` / `false` / `null` | Override the Maverick-pack auto-detection. Leave `null` to let the bot decide. |

> **Note on naming — dash vs camelCase.** The air strategy uses two different spellings in `settings.json` and that is intentional:
> - `modeOverride: "d4tw-air"` — **kebab-case with a dash**, because it's the strategy ID (matches the `getStrategy()` registry key).
> - `"d4twAir": { ... }` — **camelCase**, because it's a regular JSON field name (consistent with other settings like `farmEnabled`, `maxBattlesPerSession`).
>
> So a valid config looks like:
> ```json
> { "modeOverride": "d4tw-air", "d4twAir": { ... } }
> ```
> Zod will reject `"d4twAir"` as a `modeOverride` value, and `"d4tw-air"` as a block key won't be read.

#### Strategies

The bot has four farming strategies. Each has its own block in `settings.json`. Only the **active** strategy's block matters — others are ignored.

**Which one is active?** If `modeOverride` is set, that one. Otherwise the bot picks automatically:
- D1, D2, D3 → `standard` (empty-division farming)
- D4 with Maverick Pack → `maverickD3` (use Maverick switch + bombs)
- D4 without Maverick → `d4tw` (ground D4 TW, high damage targets)

To use the new air strategy on a D4 account, set `"modeOverride": "d4tw-air"` (auto-mode won't pick it).

**`d4tw-air` — Air medals for low-strength D4 accounts**

```json
"d4twAir": {
  "targetDamageAttacker": 30000,
  "targetDamageDefender": 50000,
  "maxBattlesPerSession": 1,
  "useWeapon": false,
  "weaponPriority": [5, 4, 3, 2, 1]
}
```

| Field | What it does |
|---|---|
| `targetDamageAttacker` | Damage to land when your country is the **attacker** in the battle. Air Battle Hero medals are awarded for top damage per round; on the losing (attacker) side, 30k is usually enough. |
| `targetDamageDefender` | Same for **defender** side. Defender medals are more contested, so the threshold is higher. |
| `maxBattlesPerSession` | How many medals to chase per farm session. Default `1` — air medals are cheap (~30 energy each). |
| `useWeapon` | `false` = fight bare-handed (no ammo consumed). `true` = use aircraft weapons Q5→Q1, fall back to bare hands if none available. |
| `weaponPriority` | Order of weapon qualities to try when `useWeapon=true`. Q5 first, then Q4, etc. Aircraft weapons only exist at Q1–Q5. |

**`d4tw` — Ground medals for high-strength D4 accounts**

```json
"d4tw": {
  "targetDamageAttacker": 130000000,
  "targetDamageDefender": 220000000,
  "maxBattlesPerSession": 1,
  "weaponPriority": [7, 6, 5, 4, 3, 2, 1]
}
```

Same idea as `d4twAir` but for ground D4. Damage targets are much higher (130M attacker, 220M defender) because ground D4 medals are contested by strong players. Don't use this strategy if your strength is below ~500k.

**`emptyDiv` — Empty-division farming for D1, D2, D3 accounts**

```json
"emptyDiv": {
  "maxBattlesPerSession": 3,
  "nativeWeaponPriority": [7, 6, 5, 4, 3, 2, 1],
  "foreignWeaponPolicy": "bomb-then-bazooka"
}
```

| Field | What it does |
|---|---|
| `maxBattlesPerSession` | Battles to chase per session. Each medal costs ~66 energy (both sides × 33 each). |
| `nativeWeaponPriority` | Weapon qualities to try when fighting in your native country. |
| `foreignWeaponPolicy` | When fighting abroad: `"bomb-then-bazooka"` throws a bomb first if available, otherwise a bazooka. `"no-weapon"` uses bare hands. |

#### Travel

```json
"travel": {
  "maxTravelCC": 100,
  "returnHomeAfterMinutes": 15,
  "returnHomeMaxCC": 500
}
```

| Field | What it does |
|---|---|
| `maxTravelCC` | Maximum currency to spend per travel hop while farming. Battles too expensive to reach are skipped. |
| `returnHomeAfterMinutes` | Bot travels back to your residence after this many minutes abroad. `0` disables. Mirrors the `.env` value with the same name — but here it can be changed without restarting. |
| `returnHomeMaxCC` | Max currency to spend on going home. Pricier trips are skipped (with Telegram alert). |

#### Farm session cooldown

```json
"farmSession": {
  "cooldownMinMinutes": 30,
  "cooldownMaxMinutes": 90
}
```

After each farm session, the bot waits a random time between Min and Max minutes before becoming eligible again. Spreads out the activity pattern.

**Tip:** the default 30–90 looks natural. Setting both to small values (e.g. 1/1) makes the bot fire as fast as possible — useful for testing but easier to detect.

#### Auto-populated (read-only)

```json
"detected": {
  "division": 4,
  "hasMaverick": false,
  "airRankNumber": 58,
  "citizenId": 9566944,
  "countryId": 72,
  "lastUpdated": "2026-05-19T14:12:10.010Z"
}
```

The bot writes its current observation here each cycle so the dashboard can display it. Editing values has no effect — they'll be overwritten on the next cycle.

---

### Common configuration recipes

**"I'm a low-strength D4 player who wants to farm air medals":**

Edit `config/settings.json`:
```json
{
  "modeOverride": "d4tw-air",
  "d4twAir": {
    "targetDamageAttacker": 30000,
    "targetDamageDefender": 50000,
    "useWeapon": false
  }
}
```

Save. The bot picks up the change within seconds.

**"I want to log in manually for a few minutes":**

```json
{ "paused": true }
```

Save. Bot stops doing anything immediately. Set back to `false` when done.

**"Just do my dailies, skip farming":**

```json
{ "farmEnabled": false }
```

**"Use my aircraft weapons":**

```json
{
  "d4twAir": {
    "useWeapon": true,
    "weaponPriority": [5, 4, 3, 2, 1]
  }
}
```

**"Tighter cooldown — more sessions per day":**

```json
{
  "farmSession": {
    "cooldownMinMinutes": 15,
    "cooldownMaxMinutes": 45
  }
}
```

**"Add a second account":**

In `.env`:
```
ERP_ACCOUNT_SLUG=alt
ERP_LOGIN=alt@example.com
ERP_PASSWORD=alt-password
```

Then `npm run bootstrap` (logs in once, saves the session), then `npm start` (runs against this account). Each account gets its own profile folder and its own `config/settings.json` is shared (so account-specific behavior comes from `modeOverride` etc.).

---

## Daily runner

```bash
npm run agent            # one cycle, then exit
npm start                # long-running: cycle every LOOP_INTERVAL_MS (default 10 min)
```

### What each cycle does

1. Computes the current **eRepublik day** (PST midnight epoch — not UTC). Loads `sessions/daily-state-{day}.json`. If the day has rolled over, the previous file is archived.
2. Reads `csrfToken`, `citizenId`, `countryId` from the live page (`SERVER_DATA` / `erepublik.citizen`).
3. Calls three read-only endpoints: daily missions, objective chests, weekly challenge.
4. **Reconciles** the API state into local memory — if the player did `work` manually (or another bot did it), the local flag is set to `source: 'external'` so the runner won't redo it.
5. **Short-circuits**: if every safe-daily action is done AND there is nothing left to claim, the cycle exits immediately. This is the hot path — most ticks of a long-running loop do nothing but a few read calls.
6. Otherwise: derives `pending = pendingActions(state)` and runs each pending action **once, in a fixed order**: `work` → `train` → `vipClaim` → `buyFood`. Each call writes to memory on success so the next cycle (or a crash recovery) sees it as done.
7. Calls three idempotent sweep functions: `collectMissionRewards`, `collectObjectiveRewards`, `collectWeeklyChallenge`. Safe to call even when nothing is claimable — they return empty lists.
8. Saves state. If anything changed since the last cycle, sends a Telegram digest (silent if no token configured).

### Actions

| Action | Mission | Notes |
|---|---|---|
| `work` | 100001 | POST `/en/economy/work`. Once per day. |
| `train` | 100003 | Sweeps all free training grounds. Once per day. |
| `buyFood` | 100011 | Buys 1 unit of the cheapest Q1 food on the home marketplace. **Hard-rejects if price > `ERP_MAX_FOOD_PRICE`**, and `amount` is hard-coded to 1. |
| `vipClaim` | — | Daily VIP gift. Idempotent. Not in `daily-missions-data`, so reconciliation cannot detect external completions — the runner is the only writer of this flag. |

Each action is a plain async function in `src/tools/*.ts` (`work.ts`, `train.ts`, `vip.ts`, `market.ts`). The runner calls them directly. There is no agent SDK, no MCP server, no model in the loop.

### Memory layout

```
sessions/
  profile/<slug>/                   # CloakBrowser profile (cookies, fingerprint)
  daily-state-{day}.json            # today's state (active)
  daily-state-{day-1}.archive.json  # archived after rollover
  weekly-state.json                 # last-claimed weekly reward id
```

`DailyState` (Zod schema in `src/memory/schema.ts`):

- `completedActions.{work|train|vipClaim|buyFood}` — each tagged `source: 'agent' | 'external'`
- `claimedMissionIds[]`, `claimedChestThresholds[]`
- `lastDigestHash` — used to suppress no-op Telegram pings

---

## Gold-farming pipeline (operator-only)

Three CLIs, none of them callable by the LLM. **All default to dry-run.** Add `--execute` to actually deploy.

### `npm run farmable` — read-only scout

Lists every active battle where:
- Your division has `wall.dom === 50` (caretaker / empty),
- The division has not ended (`division_end === false`),
- The first authoritative empty signal (`/en/military/battle-stats/...`) confirms zero damage in your division.

Use this to eyeball what's currently farmable from your residence region.

### `npm run farm-one -- --battle=<id>` — one battle, both sides

```bash
# Dry-run: prints the planned route + costs, never deploys.
npm run farm-one -- --battle=12345

# Fight one side only:
npm run farm-one -- --battle=12345 --side=invader --execute
npm run farm-one -- --battle=12345 --side=defender --execute

# Fight both sides:
npm run farm-one -- --battle=12345 --side=both --execute

# Skip the empty-division check (dangerous — use only for debugging known-good targets):
npm run farm-one -- --battle=12345 --execute --skip-empty-check
```

Sequence on `--execute`:
1. Navigate the open page to `/en/military/battlefield/{battleId}` (the browser-enforced `Referer` is what the deploy endpoint checks — not settable programmatically).
2. Cancel any stale deployment session.
3. For each requested side: `travelData` → cheapest region → `battlefieldTravel` → `fightDeploy-getInventory` → `fightDeploy-startDeploy` with Q-1 no-weapon, 33 energy/hit. On error: retry up to `MAX_HIT_ATTEMPTS` (5) and verify against `battle-console` whether the hit slipped through anyway.
4. Between sides: wait, verify the previous hit registered, then `cancelDeploy` to clear the "already fighting" lock before the next travel.

### `npm run farmer` — full pipeline across many battles

```bash
npm run farmer                       # dry-run, default cap of 5 battles
npm run farmer -- --execute          # actually deploy
```

Pipeline per pass:

1. **Discover**: `campaignsJson/list` → active battles → filter to my division + `wall.dom === 50`.
2. **Eligibility**: `campaignsJson/citizen` → keep only battles where I can deploy on **both** sides (native citizen, `isMercenary`, or `isFreedomFighter`).
3. **Filter**: drop battles younger than `ERP_FARM_MIN_BATTLE_MINUTES`, blocked countries, and any where both combatants are the same id.
4. **Route**: use a cluster-by-country router (`src/farm/routing.ts`). Plain English: *"is there a battle in the country I'm already standing in? Then fight that one first and minimize the next hop. Otherwise, bridge to the cheapest reachable cluster."* Per-hop ceiling is `ERP_FARM_MAX_TRAVEL_CC`.
5. **Verify empty**: `battle-stats/...` — `wall.dom === 50` alone is not enough.
6. **Fight both sides** (same as `farm-one`), advance routing state, log hops + total CC.

#### Stop conditions

| Condition | What happens |
|---|---|
| `farmedCount >= ERP_FARM_MAX_BATTLES` | Normal stop. |
| `fuelLeft < ERP_FARM_MIN_FUEL` | Stop — out of vehicle fuel. |
| `poolEnergy < ERP_FARM_TOTAL_ENERGY * 2` | Stop — not enough energy for another both-sides round. |
| `Forbidden` from any deploy endpoint | **Abort the whole run.** IP/account is flagged. Swap IP / wait — do not retry. |
| `EnergyExhaustedError` (≥ half of retries were "Not enough energy") | Abort the run, pool is dry. |
| No reachable battle within `ERP_FARM_MAX_TRAVEL_CC` per hop | Stop — log how many were left unreachable. |

End-of-run summary prints: battles farmed, attempts per side, last fuel, total hops, total travel CC, and the country sequence (e.g. `c40 → c40 → c11 → c11 → c33`).

### Debug helpers

| Command | Purpose |
|---|---|
| `npm run debug-deploy` | One-shot deploy probe with verbose request/response logging. Useful when a 403 needs picking apart. |
| `npm run debug-headers` | Dumps the headers the in-page `fetch` is actually sending. Useful for diffing against a working browser session. |

---

## All scripts

| Command | Purpose |
|---|---|
| `npm run bootstrap` | One-shot manual login (headed). Persists CloakBrowser profile. |
| `npm run healthcheck` | Verifies the persisted session still authenticates. |
| `npm run missions` | Prints today's missions and short-circuit status (read-only). |
| `npm run agent` | LLM daily loop, **one** cycle. |
| `npm start` | LLM daily loop, long-running. Sleeps `LOOP_INTERVAL_MS` between cycles. |
| `npm run farmable` | Lists candidate battles (empty division, wall.dom=50). |
| `npm run farm-one` | Single-battle farming. Dry-run unless `--execute`. |
| `npm run farmer` | Multi-battle farming with routing. Dry-run unless `--execute`. |
| `npm run debug-deploy` | Verbose one-shot deploy probe. |
| `npm run debug-headers` | Inspect in-page fetch headers. |
| `npm run typecheck` | `tsc --noEmit`. |

There is no test runner and no lint command in this project.

---

## Advanced: standalone farming CLI env vars

> Most users don't need this section. The daily runner reads its config from `.env` and `config/settings.json` (see [Configuration](#configuration) above). The variables below only affect the operator-only standalone farming CLIs (`npm run farmer` / `npm run farm-one`) — those scripts bypass the daily runner's gate and pacing logic.

| Var | Default | Purpose |
|---|---|---|
| `ERP_FARM_MAX_BATTLES` | `5` | Per-run cap. |
| `ERP_FARM_MAX_TRAVEL_CC` | `400` | Per-hop travel ceiling (in country currency). |
| `ERP_FARM_MIN_FUEL` | `10` | Stop when vehicle fuel drops below this. |
| `ERP_FARM_MIN_BATTLE_MINUTES` | `5` | Skip battles younger than this. |
| `ERP_FARM_WEAPON_QUALITY` | `-1` | `-1` = no-weapon (cheap). Q10 bazookas cost 11 energy/hit but are premium. |
| `ERP_FARM_TOTAL_ENERGY` | `33` | Energy spent per hit. |
| `ERP_FARM_MAX_ATTEMPTS` | `10` | Per-side deploy retries before giving up. |
| `ERP_FARM_RETRY_DELAY_MS` | `500` | Delay between retries. |
| `ERP_FARM_HANDOFF_SLEEP_MS` | `2000` | Wait between side A and side B so the first deploy settles. |
| `ERP_FARM_BLOCKED_COUNTRIES` | `''` | CSV of country IDs to never deploy on. |
| `ERP_FARM_WHITELIST_COUNTRIES` | `''` | CSV of country IDs to prefer (sorted first in the queue). |

---

## Safety boundaries

The two safety layers are independent — both have to be passed for any HTTP call to go out.

### 1. Endpoint allow-list (`src/transport/allowlist.ts`)

Every HTTP call goes through `apiCall()` → `assertAllowed(method, path)` → throws if `(method, path)` isn't in `PHASE_1_ALLOWLIST`. The current set covers:

- **Auth / profile read**: `/en/main`, `/en/login`, `/en/citizen/profile/...`, `/en/main/messages-paginated`
- **Mission / objective / weekly**: `daily-missions-data`, `objective-status`, `objective-claim-reward`, `mission-solve`, `weekly-challenge-data`, `weekly-challenge-collect-all`
- **Safe daily actions**: `economy/work`, `training-grounds-json`, `economy/train`, `marketplaceAjax`, `marketplaceActions`, `vip-claim`
- **Farming**: `campaignsJson/list`, `campaignsJson/citizen`, `battle-stats/...`, `travelData`, `battlefieldTravel`, `fightDeploy-{getInventory,startDeploy,cancelDeploy}`, `battle-console`

> Adding any new endpoint **requires editing `allowlist.ts`**. There is no other way in.

### 2. Per-action guards

- `buyFromOffer` hard-rejects `amount !== 1`.
- `buyOneCheapestFood` is hard-coded to `industry=FOOD, quality=1` and refuses prices above `ERP_MAX_FOOD_PRICE`.
- The daily runner calls each action **once per cycle**, gated by `pendingActions(state)` reading from memory. A success flips the flag immediately so re-entry (next cycle or crash recovery) skips it.
- Playwright clicks are reserved for the login flow in `bootstrap.ts`. Everything else is `fetch` through the authenticated browser context, with allow-list enforcement.

### 3. Forbidden = stop

A `Forbidden` response from any deploy endpoint means the IP/account is flagged. The farm runner throws `ForbiddenError` and aborts the entire run. Do not retry — swap IP or wait for the cooldown.

---

## Architecture (one screen)

```
agent/runner.ts                  long-running loop, day rollover, short-circuit, digest
  agent/cycle.ts                 reconcile(API → memory)
  tools/*.ts                     semantic operations (work, train, market, claim, …)
    transport/apiCall.ts         context.request.fetch + CSRF + allow-list check
      transport/allowlist.ts     the inviolable endpoint set
        browser/session.ts       CloakBrowser persistent context

farmRunner.ts / farmOne.ts       operator CLIs
  farm/routing.ts                cluster-by-country router
  tools/battles.ts               campaign discovery + eligibility + empty check
  tools/farm.ts                  travel + inventory + deploy + verify
    transport/apiCall.ts         (same enforcement applies)
```

**Layering rule**: do not skip levels. Everything goes through `apiCall` so the allow-list always fires.

**Memory-write rule**: only `agent/runner.ts` mutates `DailyState` / `WeeklyState`. `tools/*.ts` are pure — they return results and never persist.

---

## Conventions specific to this codebase

- **ESM + TypeScript via `tsx`**, no build step. Imports use `.js` suffix (`../tools/missions.js`) even though files are `.ts` — required by `moduleResolution: Bundler` + ESM.
- **Form bodies** are `application/x-www-form-urlencoded`. `apiCall()` automatically prepends `_token: csrf` and sets `X-Requested-With: XMLHttpRequest` on POSTs. Don't bypass it.
- **CSRF is per-page, not per-session.** Each cycle re-reads it from the live page.
- **Mission IDs**: 100001 = work, 100003 = train, 100011 = buy food. VIP claim is not exposed in `daily-missions-data` — its tool is the only writer for that flag.
- **`Referer` matters for deploys.** The farming CLIs `page.goto(/military/battlefield/{id})` before any deploy fetch because the browser-enforced `Referer` is what the deploy endpoints check.

---

## Stack

- Node.js 22+, TypeScript, ESM (no build step — `tsx` runs sources directly)
- [`cloakbrowser`](https://github.com/CloakHQ/CloakBrowser) — stealth Chromium with source-level fingerprint patches
- `playwright-core` — browser context API surface
- `zod` — env, memory, input validation

## Disclaimer

Personal automation tool. Use against your own account. Respect [eRepublik Terms of Service](https://www.erepublik.com/en/main/terms-and-conditions).
