# Windows distribution — portable ZIP for non-technical users

**Date:** 2026-05-16
**Status:** draft, awaiting user review
**Scope:** Packaging, release pipeline, and end-user UX for shipping the existing daily runner + farming pipeline to non-technical Windows users. No changes to `src/agent/`, `src/farm/`, `src/tools/`, or `src/transport/` semantics. No new HTTP endpoints. No changes to `allowlist.ts`.

---

## 1. Goal

Let a Windows user with no programming background install and run `erepublik-agent` end-to-end without:

- Installing Node.js separately
- Installing Docker
- Touching a `.env` file in a text editor
- Running anything from PowerShell or `cmd` directly
- Knowing what `npm`, `tsx`, or `git` are

Concretely, the user journey from "I have nothing" to "the bot is running" must be: download a ZIP from a Telegram channel → extract → double-click three `.bat` files in order (`setup` → `bootstrap` → `start`).

**One `start.bat` runs everything.** The daily runner (`src/agent/runner.ts`) already invokes the farming pipeline automatically via `decideFarming` (`src/agent/fuelBudget.ts`) on each cycle — gold-farming is a first-class part of the loop, paced by the weekly fuel budget. We do **not** ship a separate `farmer.bat`; that would split the user's mental model and require them to remember to launch two things. Farming is non-negotiable for the value proposition of this distribution.

Secondary goal: keep the existing developer workflow (`npm run agent`, `npm run farmer`, etc.) intact. Nothing about the source tree's day-to-day usage should regress.

Non-goals (deferred to v1.1):

- Code signing certificate (Windows SmartScreen friendliness)
- Self-extracting `.exe` instead of `.zip`
- Tray icon / GUI / desktop shortcut
- Auto-update mechanism
- macOS and Linux installer packages (developers there can `git clone`)
- npm and public Docker channels (no audience; ~10% technical users can `git clone` from the repo)

---

## 2. Audience and assumptions

**Audience.** ~90% of clients are non-technical Windows users. They:

- Know how to download a file from Telegram and extract a ZIP.
- Know how to double-click an icon.
- Are scared by anything that looks like a programming tool (terminal, code, configuration files).
- May not have admin rights on their machine (some run on locked-down work laptops).
- Likely run Windows 10 or 11 x64. We do not support Windows 7/8 or 32-bit.

**The remaining ~10%** are technical users on Linux/macOS who can clone the repo and run `npm install && npm start` from existing docs. They are not a target of this spec.

**English-only.** All user-facing text — README, `.bat` prompts, log messages, error messages — is in **English**. Ukrainian is not used in the artifact.

---

## 3. Deliverable: `erepublik-agent-vX.Y.Z-windows-x64.zip`

Single artifact per release, around ~50 MB compressed (Node runtime + production `node_modules` + compiled JS). Chromium is **not** in the ZIP — see §3.3.

### 3.1 Contents

```
erepublik-agent/
├── node/
│   └── node.exe                     # Portable Node.js 22 LTS (Windows x64)
├── app/
│   ├── dist/                        # Compiled JS (tsc output)
│   ├── data/
│   │   └── countries.json           # Country ID ↔ name/aliases reference
│   ├── node_modules/                # Production deps only (includes cloakbrowser CLI)
│   └── package.json                 # For dependency resolution at runtime
├── chromium-cache/                  # Empty on download; populated by bootstrap.bat
│   └── .gitkeep
├── sessions/                        # Empty on first install
│   └── .gitkeep
├── config/
│   └── .env                         # Created by setup.bat; not in the ZIP
├── logs/                            # Empty on first install
│   └── .gitkeep
├── setup.bat                        # Interactive config wizard (English)
├── bootstrap.bat                    # Downloads Chromium (first run only), then headed login
├── start.bat                        # Start the daily runner
├── stop.bat                         # Kill the running agent
└── README.txt                       # Plain-text English instructions
```

Approximate ZIP size: **~50 MB compressed** (node.exe + production node_modules + compiled JS). CloakBrowser's Chromium binary (~200 MB unpacked) is downloaded once during the first `bootstrap.bat` run, into `chromium-cache/`.

### 3.2 Why portable Node, not Node-SEA (Single Executable Application)

Node 21+ supports Single Executable Applications. We do **not** use it because:

- CloakBrowser ships its own Chromium binary that has to live on disk anyway; the SEA "single binary" promise is partly defeated.
- SEA requires bundling all sources into a snapshot. The existing ESM + `.js` import-suffix convention complicates this.
- Portable Node is well-understood, supports the same `node.exe app/dist/agent/runner.js` invocation pattern as a developer would expect, and is trivial to update when Node releases a new LTS.

The tradeoff is ~50 MB of `node/` directory in the ZIP. Acceptable.

### 3.3 Why download Chromium at install time (not bundle it)

The ZIP does **not** ship a pre-warmed `chromium-cache/`. The user's first `bootstrap.bat` triggers `cloakbrowser install`, which downloads ~200 MB to `chromium-cache/` and proceeds with the login. Subsequent runs reuse the cache.

Rationale:

- **Smaller artifact.** ~50 MB vs ~250 MB. Faster Telegram upload/download, lighter on the user's "Downloads" folder.
- **Version control stays with us, not with CloakBrowser's auto-updater.** `cloakbrowser`'s npm package hard-codes which Chromium version it downloads — there is no `--version` flag on the CLI. We pin Chromium **indirectly** by pinning the `cloakbrowser` package version in `app/package.json`. With `CLOAKBROWSER_AUTO_UPDATE=false` set by every `.bat`, the install fetches exactly the version that `cloakbrowser@<pinned>` knows about. To roll out a new Chromium to users, the maintainer bumps `cloakbrowser` in `package.json`, tests, releases a new ZIP. Same model as the Dockerfile.
- **First-boot UX cost is acceptable.** `cloakbrowser install` prints its own progress (extraction percentage), so `bootstrap.bat` is not silent. It runs once per install, on the user's explicit "I am setting this up now" action — not in the middle of farming.

Risks accepted:

- **Internet required at first bootstrap.** If a user is behind a corporate proxy that blocks the CloakBrowser CDN, install fails. `bootstrap.bat` reports the error clearly and points to the README troubleshooting section.
- **Long-lived CDN dependency.** If CloakBrowser ever removes a Chromium release from both their CDN and their GitHub Releases (the fallback that `cloakbrowser/dist/download.js` falls back to), old ZIP releases stop being installable on new machines. Existing installs are unaffected. Mitigation: bump the bundled `cloakbrowser` version and re-release periodically anyway, and never rely on a single old release being installable for years.

---

## 4. User flow

### 4.1 First-time install (the only time it's hard)

1. **Download.** User clicks the link in the Telegram channel announcement, browser saves `erepublik-agent-v1.0.0-windows-x64.zip` to `Downloads/`.
2. **Extract.** Right-click → "Extract All…" → choose any folder (Desktop, Documents, doesn't matter). No admin rights required. Path with spaces or non-ASCII characters (Ukrainian usernames) must work.
3. **Configure.** Double-click `setup.bat`. A console window opens with an interactive wizard. See §5.1.
4. **Log in.** Double-click `bootstrap.bat`. A real browser window opens showing the eRepublik login page. User signs in manually, solves any Cloudflare/captcha challenge, and the script closes the browser automatically once it detects an authenticated session.
5. **Start.** Double-click `start.bat`. A console window appears, prints the bot's status, and stays open. User minimizes it. Done.

### 4.2 Day-to-day

- Want to stop the bot? Double-click `stop.bat`, OR close the console window from `start.bat`.
- Want to start again after a reboot? Double-click `start.bat`.
- Want to change config (e.g., new password)? Double-click `setup.bat` again — it detects the existing `.env`, asks "Keep current value or change?" for each field.
- Want to update? Download the new ZIP, extract over the existing folder (or to a new folder and copy `sessions/` + `config/` across). Auto-update is v1.1.

### 4.3 What the user never has to do

- Open a text editor.
- Open PowerShell or `cmd` and type commands.
- Install Node.js, Python, or any other tool.
- Understand what a `.env` file is.
- Understand what "CSRF token" or "session cookie" means.

---

## 5. Component design

### 5.1 `setup.bat` — interactive configuration wizard

A `cmd.exe` script that asks each required env var in order, with sensible defaults and inline validation. Output written to `config/.env`.

**Prompts (all in English):**

```
=====================================================
  erepublik-agent setup
=====================================================

This wizard will configure the bot. Press Enter to keep
the default shown in [brackets], or type a new value.

--- Account ---
eRepublik email address: _
eRepublik password: _              (input is masked)
Account label [main]: _            (becomes ERP_ACCOUNT_SLUG)

--- Daily actions ---
Maximum Q1 food price [3.0]: _

--- Gold farming (always on; tuned by weekly fuel budget) ---
Max travel cost per battle hop, in CC [400]: _
Minimum fuel barrels to keep in inventory [10]: _
Blocked countries (names or IDs, comma-separated; e.g. "Poland, Romania, 33")
Type 'list' to see all available countries, blank for none.
> _

--- Auto return-home ---
Return home after how many minutes abroad? [15, 0 to disable]: _
Max return-home travel cost [500]: _

--- Telegram notifications (optional) ---
Press Enter twice to skip Telegram setup.

Telegram bot token []: _
Telegram chat ID []: _

--- Captcha solver (optional) ---
Captcha provider [none / 2captcha] [none]: _

(if 2captcha)
2captcha API key []: _

--- Advanced tuning ---
Show advanced options? [y/N]: _

(if y)
Cycle interval in minutes [10]: _
(plus a few more rarely-touched knobs — see README §Advanced)

Writing config/.env... OK.

Next step: double-click bootstrap.bat to log in to eRepublik.
Press any key to close this window.
```

The wizard intentionally skips most farming knobs (`ERP_FARM_WEAPON_QUALITY`, `ERP_FARM_TOTAL_ENERGY`, `ERP_FARM_MAX_ATTEMPTS`, etc.) because their defaults are sane and a non-technical user has no way to reason about them. Power users can edit `config/.env` directly; the README lists every supported variable.

**Implementation notes:**

- Use `set /p VAR=` for prompts. Use the standard PowerShell one-liner for masked password input (`Read-Host -AsSecureString` piped to plaintext, single invocation).
- If `config/.env` already exists, the wizard runs in "edit mode": each prompt's default is the current value, blank input keeps it.
- Numeric inputs (prices, fuel thresholds) validated with a regex; on failure, reprompt with an error message.
- Re-run safe. Idempotent.
- Echoes a clear "next step" pointer at the end. Pauses on exit so the window doesn't disappear before the user reads it.

**Failure modes handled:**

- User closes the window mid-wizard → no `.env` written, no harm. Re-run starts over.
- `config/` directory missing → created.
- Existing `.env` is malformed → wizard ignores it, treats values as missing, asks fresh.

### 5.2 `bootstrap.bat` — Chromium download (first run only) + interactive login

Two phases in one `.bat`. The first runs only on the first bootstrap; the second runs every time the user re-bootstraps (e.g., after a session expiry months later).

**Pseudo-code:**

```cmd
@echo off
cd /d "%~dp0"

if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)

set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set HEADED=true

:: Phase 1: download Chromium if cache is empty.
:: We check for any chromium-* subdirectory under the cache.
dir /b chromium-cache\chromium-* >nul 2>&1
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

:: Phase 2: invoke the existing bootstrap.ts to open headed browser
::          and wait for the user to log in manually.
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
```

**Cache-presence check.** `cloakbrowser install` is idempotent — running it when the binary already exists is a no-op, just slower (a metadata check). But the `dir /b chromium-cache\chromium-*` check avoids even that delay on the warm path, and means a user re-running `bootstrap.bat` after the cache is populated goes straight to the login step.

**`CLOAKBROWSER_AUTO_UPDATE=false`** is set so the install + runtime use the version pinned by `cloakbrowser` in `app/package.json`, never silently upgrading mid-run.

The existing bootstrap code in `src/bootstrap.ts` already handles the login flow; this `.bat` is a launcher around it plus the one-time Chromium fetch.

### 5.3 `start.bat` — run the daily runner

```cmd
@echo off
cd /d "%~dp0"
if not exist config\.env (
    echo Configuration not found. Please run setup.bat first.
    pause
    exit /b 1
)
dir /b chromium-cache\chromium-* >nul 2>&1
if errorlevel 1 (
    echo Chromium not installed yet. Please run bootstrap.bat first.
    pause
    exit /b 1
)
set CLOAKBROWSER_CACHE_DIR=%~dp0chromium-cache
set CLOAKBROWSER_AUTO_UPDATE=false
set ERP_FILE_LOGGING=true
node\node.exe app\dist\agent\runner.js
```

- Output is streamed to the console window AND duplicated to `logs/agent-YYYY-MM-DD.log` (via a small Node-side change to the runner — see §6.3).
- Closing the window kills the process (default cmd.exe behavior).
- Writes a PID file `logs/agent.pid` on startup so `stop.bat` can find it.
- Refuses to start if `chromium-cache/` is empty — surfaces a clear "run bootstrap first" error instead of letting CloakBrowser attempt its own download mid-cycle.

### 5.4 `stop.bat` — graceful shutdown

```cmd
@echo off
cd /d "%~dp0"
if not exist logs\agent.pid (
    echo No running agent found.
    pause
    exit /b 0
)
set /p PID=<logs\agent.pid
taskkill /PID %PID% /F >nul 2>&1
del logs\agent.pid
echo Agent stopped.
pause
```

- Uses `taskkill /F` because the long-running cycle has no clean signal-handling in the current runner. Adding SIGTERM handling is out of scope.
- Falls back gracefully if the PID file is stale (process already died).

### 5.5 `README.txt` — plain-text instructions

A short (≤80 lines) plain-text README in English covering exactly: download → extract → setup → bootstrap → start. No markdown headers, no code blocks. One file. One read in five minutes.

Includes troubleshooting for the four most likely failure modes:

1. "Windows protected your PC" SmartScreen warning → click "More info" → "Run anyway".
2. `bootstrap.bat` fails during Chromium download → check internet/firewall; corporate proxies that block the CloakBrowser CDN need an exception, or run bootstrap from a personal network once.
3. Antivirus quarantines `chromium-cache/.../chrome.exe` → add the install folder to the AV exclusion list.
4. Login screen reappears every day → bootstrap session expired; rerun `bootstrap.bat`. Chromium is **not** re-downloaded; only the login is repeated.

### 5.6 Country resolver — accepting names in `setup.bat`

Non-technical users do not know country IDs. They know country names ("Poland", "Romania") or short codes ("POL", "PL"). The `Blocked countries` prompt in `setup.bat` accepts any mix of names, codes, and numeric IDs; a small helper resolves the input before writing `.env`.

**Data file: `data/countries.json`.** A static, hand-maintained JSON array of every country in the eRepublik game, sorted by `id`. Each entry has `id` and `name`:

```json
[
  { "id": 1,  "name": "Romania" },
  { "id": 9,  "name": "Brazil" },
  { "id": 27, "name": "Argentina" },
  …
]
```

**Exactly 74 countries** at the time of writing (verified against the live API response below). IDs are non-contiguous (e.g., 1, 9, 10, 11, 12, ..., 167, 171) and stable since the game launched in 2007. The committed file is the single source of truth at release time; it is copied to `app/data/countries.json` during the build.

**How the file was populated, and how it stays correct.** The 74 entries come verbatim from the `countries` object in `https://www.erepublik.com/en/military/campaignsJson/list` (a public, unauthenticated GET — verified out-of-band: HTTP 200, ~360 KB JSON, shape `{ "<id>": { id, name, allies, is_empire, cotd }, … }`). The file was generated once during spec drafting via:

```bash
jq '[.countries | to_entries | sort_by(.value.id) | .[] | {id: .value.id, name: .value.name}]' \
  <(curl -sS https://www.erepublik.com/en/military/campaignsJson/list) \
  > data/countries.json
```

It is then **hand-maintained**. eRepublik rarely adds countries — when it does, the maintainer re-runs the snippet above and reviews the diff before committing.

**Validator (optional, not blocking)** — `scripts/validate-countries-json.ts`. A small Node script the maintainer runs locally (and optionally CI runs nightly) that:

1. Fetches the same endpoint.
2. Diffs the live `.countries` against the committed `data/countries.json`.
3. Exits non-zero on any discrepancy (new country, missing country, renamed country), printing a unified diff.

The validator is **not** part of the release pipeline, and **not** part of `bootstrap.bat`. It exists solely so the maintainer can detect catalog drift between releases. The runtime never touches the endpoint for country resolution.

**No 3-letter codes in v1.** The catalog has `id` + `name` only. Case-insensitive name matching is sufficient for the wizard's "Poland, Argentina" input. Aliases (community shorthand like "POL", "ARG") can be added as a `code` field later if real-world feedback shows users want it; the resolver in §5.6 already accepts unknown short tokens gracefully via the "did you mean?" suggestion path.

**Resolver: `src/util/resolveCountries.ts`.** A pure function that takes the raw input string and returns the resolved IDs:

```ts
export function resolveCountries(
  input: string,
  catalog: Country[],
): { ids: number[]; unknown: string[]; suggestions: Record<string, string> }
```

- Splits the input by comma, trims each token.
- For each token:
  - Numeric? → keep as ID after verifying it exists in the catalog (unknown ID → unknown[]).
  - Exact case-insensitive match on `name` or `code`? → keep as ID.
  - No match? → push to `unknown[]`, and use Levenshtein distance to suggest the closest catalog entry (e.g., "Polnd" → "Poland").
- Dedupes the final ID list.

**CLI bridge: `src/util/resolveCountriesCli.ts`** — a tiny script that `setup.bat` invokes via:

```cmd
node\node.exe app\dist\util\resolveCountriesCli.js "%USER_INPUT%"
```

The CLI prints either the resolved CSV (`27,1,33`) on stdout for the success path, or a non-zero exit + error message for unrecognized tokens (with the "did you mean?" suggestions). `setup.bat` reads stdout into a variable, re-prompts on failure.

**`list` command.** If the user types `list` at the prompt, `setup.bat` calls a separate mode:

```cmd
node\node.exe app\dist\util\resolveCountriesCli.js --list
```

…which prints the full catalog in 3 columns sorted by name, then `setup.bat` re-prompts.

---

## 6. Codebase changes

The agent runs from `app/dist/` instead of `tsx src/`, which requires three changes.

### 6.1 Add a TypeScript build step

Today there is no build. `tsx` runs `.ts` files directly. For Windows distribution we need plain `.js` files because shipping `tsx` + `typescript` to a non-tech user adds ~50 MB and a second dependency surface for no benefit.

- New `tsconfig.build.json` extending `tsconfig.json` with `noEmit: false`, `outDir: dist`, no test files.
- New npm script: `"build": "tsc -p tsconfig.build.json"`.
- Imports already use `.js` suffix (`../tools/missions.js` for a `.ts` source) — this works correctly when targeting compiled JS output. No source changes needed.
- The development workflow (`npm run agent`, `npm run farmer`, etc.) keeps using `tsx` and is **not** affected.

Risk: a few `import.meta.url`-style file-path patterns may resolve differently between `tsx` and compiled output. Audit `src/` for any path resolution that assumes `.ts` extensions or source-tree layout. Spot-check finds none, but verify during implementation.

### 6.2 Configurable runtime paths

Today: `sessions/`, `config`, and the env file are resolved relative to `process.cwd()` (effectively the repo root for developers).

For the Windows ZIP, we need paths resolved relative to the ZIP root (the folder the user extracted to), regardless of where they double-clicked from.

- Each `.bat` does `cd /d "%~dp0"` first, which sets cwd to the ZIP root.
- Add a single `paths.ts` helper that resolves `SESSIONS_DIR`, `CONFIG_DIR`, `LOGS_DIR` from env (default to `${cwd}/sessions`, `${cwd}/config`, `${cwd}/logs`). The build pipeline sets these via the `.bat` files.
- The existing `dotenv` config call needs to load from `config/.env` instead of `.env`. Either pass `path: 'config/.env'` to `dotenv.config()` or symlink/copy. Cleaner: change the load path centrally.

This is a 1-2 file change in `src/`, touching the session loader and dotenv init only.

### 6.3 PID file + log file

Two small additions to `src/agent/runner.ts`:

- On startup, write `process.pid` to `${LOGS_DIR}/agent.pid`. On graceful exit, delete it. (`taskkill /F` won't run cleanup, but the file will be overwritten on next start anyway.)
- Tee `console.log` / `console.error` to `${LOGS_DIR}/agent-${eRepublikDay}.log` in addition to stdout, with daily rotation matching the existing day calculation.

Both behaviors gated on an env var (`ERP_FILE_LOGGING=true`) so the developer flow keeps the simple `npm run agent` behavior.

### 6.4 Country catalog + resolver

New files:

- `data/countries.json` — committed static catalog with exactly 74 entries (the current game roster, derived from the API but kept as a hand-maintained file). Loaded at runtime by `resolveCountries.ts` and at build time copied to `app/data/countries.json` in the ZIP.
- `scripts/validate-countries-json.ts` — optional drift detector. Anonymous GET to the campaigns endpoint, diff against the committed file, exits non-zero on mismatch. **Not** part of the release pipeline; run manually or by a nightly maintenance job.
- `src/util/resolveCountries.ts` — pure function (`(input, catalog) => { ids, unknown, suggestions }`).
- `src/util/resolveCountriesCli.ts` — CLI bridge used by `setup.bat`. Exits non-zero on unrecognized tokens.

Verification of correctness:

1. **The committed file is the truth.** It is populated once from the live API output (during spec drafting) and reviewed by the maintainer. Subsequent edits go through PRs.
2. **Validator catches drift.** When eRepublik adds a country (rare event), the validator script fails and the maintainer hand-updates `data/countries.json`. Diff is reviewed in the PR.
3. **The runtime never fetches countries.** No HTTP call during `setup.bat`, `bootstrap.bat`, or `start.bat` touches `campaignsJson/list` for catalog resolution. Failure modes around network/IP/auth are eliminated for this concern.

No changes to `allowlist.ts` — neither the validator nor the runtime resolver goes through `apiCall`. The validator is an anonymous Node `fetch` from a maintenance script outside the agent runtime.

---

## 7. Build and release pipeline

GitHub Actions workflow `.github/workflows/release-windows.yml` triggered on git tag push (`v*.*.*`):

1. **Job runs on `windows-latest` runner.** Not strictly required (we no longer pre-warm Chromium in the artifact), but keeps `npm ci --omit=dev` running in the same OS as the target, which avoids any platform-specific quirks in the staged `node_modules/`.
2. Check out repo at the tag.
3. Set up Node 22 LTS via `actions/setup-node@v4`.
4. `npm ci` — install all deps including dev.
5. `npm run build` — compile to `dist/`.
6. Stage the ZIP layout in a temp dir:
   - Download portable Node 22 LTS zip from `nodejs.org/dist/...` and unpack `node.exe` into `staging/node/`.
   - Copy `dist/` to `staging/app/dist/`.
   - Copy `data/countries.json` to `staging/app/data/countries.json`.
   - Copy `package.json` and `package-lock.json` to `staging/app/`.
   - Run `npm ci --omit=dev --prefix staging/app` to populate `staging/app/node_modules/` with prod deps only (including `cloakbrowser`, whose CLI is invoked at first bootstrap to download Chromium).
   - Create empty `staging/chromium-cache/.gitkeep`, `staging/sessions/.gitkeep`, `staging/logs/.gitkeep`, `staging/config/.gitkeep`. **Do not** pre-warm Chromium — the first `bootstrap.bat` run on the user's machine downloads it (§3.3).
   - Copy `windows/*.bat` and `windows/README.txt` from the repo to `staging/`.
7. Zip `staging/` as `erepublik-agent-${VERSION}-windows-x64.zip`.
8. Upload the artifact to the GitHub Release for the triggering tag (`softprops/action-gh-release`).

The repo gains a top-level `windows/` directory holding the `.bat` files, README, and any Windows-specific assets. Source for those files is version-controlled and reviewable.

The total CI run is ~5-10 minutes per release.

### 7.1 Versioning

- `npm version patch|minor|major` bumps `package.json` and creates a git tag.
- Tag push triggers the workflow.
- The workflow embeds the version into the artifact filename and into a `app/VERSION` text file so the running bot can log its version.

---

## 8. Distribution channel

**Primary:** Telegram channel announcement. Each release posts:

- A short changelog (3-5 bullets, plain English).
- The ZIP attached directly (Telegram's 2 GB upload limit easily fits our ~250 MB).
- A link to the GitHub Release page for users who prefer browser download.

**Canonical storage:** GitHub Releases. Always-available, free CDN, version history preserved.

**Future (v1.1):** simple landing page at `yurii.live/erepublik-agent` with a "Download for Windows" button that pulls the latest release artifact via the GitHub Releases API. Out of scope for v1.

---

## 9. Safety, support, and out-of-band concerns

### 9.1 Code visibility

The ZIP ships **compiled but un-minified JavaScript** in `app/dist/`. Anyone with the ZIP can read the code. We are not pretending otherwise. If source-code secrecy ever becomes a requirement, add `esbuild --minify` or `bytenode` compilation as a v2 step. Out of scope for v1.

### 9.2 Update discipline

Users will run old versions for weeks at a time. Implications:

- The endpoint allow-list in old releases is frozen. If eRepublik retires or renames an endpoint, old releases break silently. Mitigation: include a one-line "current version" check on each cycle that hits a small JSON file at `yurii.live/erepublik-agent/version.json` and logs (does **not** block) when behind. Out of scope for v1 if simpler; can add in v1.1.

### 9.3 Telemetry / phone-home

**None.** The bot only contacts `erepublik.com`, `*.cloakbrowser.dev` (for any future runtime check the SDK might do), and the user-configured Telegram bot endpoint. No analytics, no error reporting to me, no version checks for v1.

### 9.4 Support load

A single human (the author) cannot debug 50 non-tech users' Windows machines on a Telegram chat. Two countermeasures:

- `logs/agent-YYYY-MM-DD.log` captures everything. Standard support flow: "send me the latest log file."
- Each release ships with a `version.txt` and a startup log line including version, Windows build, account slug. So when a user pastes a log, the version is unambiguous.

These are operational, not in the spec. Listed here so we don't pretend they don't exist.

### 9.5 eRepublik ToS

The bot has always violated eRepublik's terms of service. Distributing it to non-tech users does not change that. Users assume the same risk as the author has been assuming. The README states this in plain English; the Telegram channel description states it once; there is no further hand-holding.

---

## 10. Implementation phases

Roughly 5-7 working days, in the order below. Each phase produces a checkable artifact.

1. **Build step** (~1 day). Add `tsconfig.build.json`, `npm run build`, verify `node dist/agent/runner.js` works locally on macOS.
2. **Runtime paths + log/PID** (~1 day). Centralize sessions/config/logs dir resolution, wire `dotenv` to `config/.env`, add PID file + tee logging behind `ERP_FILE_LOGGING`.
3. **Country catalog + resolver** (~0.5 day). `data/countries.json` already exists (74 entries, committed during spec drafting). Spot-check it against the [eRepublik wiki country list](https://wiki.erepublik.com/index.php?title=Country) for the 20 most-played countries — sanity anchors confirmed during drafting: Romania id=1, Brazil id=9, Argentina id=27, Poland id=35, USA id=24, Albania id=167. Write `scripts/validate-countries-json.ts` (drift detector). Write `src/util/resolveCountries.ts` + `src/util/resolveCountriesCli.ts`. Unit-test the resolver against `data/countries.json`.
4. **`.bat` files** (~1 day). Write `setup.bat`, `bootstrap.bat`, `start.bat`, `stop.bat` in a new `windows/` directory. Wire the country resolver into the `setup.bat` blocked-countries prompt. Test each manually on a Windows VM.
5. **GitHub Actions workflow** (~1 day). Build the ZIP staging logic (including copying `data/countries.json` into `app/data/`), smoke-test by running the workflow on a draft tag.
6. **End-to-end test on real Windows machine** (~1-2 days). Fresh Windows 11 VM. Walk through the full user flow: download → extract → setup (including a `list` lookup and a misspelled country name to exercise the suggestion path) → bootstrap (verify Chromium downloads and progress is visible) → start → leave running overnight → check digest delivery. Also test: re-running `bootstrap.bat` after Chromium is already installed should skip the download.
7. **README + Telegram release post** (~0.5 day). Write the plain-text English README. Draft the Telegram announcement template.

Each phase is independently mergeable. Phases 1-3 land first as ordinary refactors that don't touch user-facing behavior; the developer workflow keeps working. Phases 4-7 are Windows-only and don't affect the main repo flow.

---

## 11. Out of scope (explicit)

- Auto-update mechanism (v1.1)
- Code signing certificate (v1.1)
- Tray icon / GUI desktop app (W1, separate spec)
- Public npm package (no audience)
- Public Docker image on GHCR (no audience)
- macOS / Linux installers (developer-only audience uses `git clone`)
- Phone-home telemetry (privacy + simplicity)
- Multi-account UI in setup.bat (single account per install for v1)
- In-product update notifications

---

## 12. Open questions for review

None. All decisions in this spec are concrete. If something feels under-specified during implementation, the rule of thumb is: choose the option that minimizes user-facing friction, even at the cost of more author-side complexity.
