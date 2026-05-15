# Gold-farming routing — deterministic country-batched sequencing

**Date:** 2026-05-15
**Status:** approved, ready to plan
**Scope:** `src/farmRunner.ts` only. No changes to `agent/` (LLM stays out), no allow-list changes, no MCP tools.

---

## 1. Goal

Reduce total CC spent on travel during a `npm run farmer` pass by ordering candidate battles so that consecutive fights stay in the same country whenever possible, and travel costs are computed from the **current** location rather than always from residence.

Secondary goals:

- Make the run sequence legible in logs (operator can read "PL → PL → DE → DE → SE" and trust the algorithm)
- Bump retry count from 5 → 10 so transient cooldowns don't burn battles
- Keep the LLM out of the farming loop entirely (token cost stays at zero for farming)

Non-goals: optimal routing (TSP), LLM-driven battle selection, persistent routing memory across runs, multi-account coordination.

---

## 2. Current behavior and the bug it hides

`farmRunner.ts:323-324` calls `findCheapestTravelRegion(..., info.residenceRegionId, ...)` for every candidate battle. After the first battle is fought, the player is no longer in the residence region — they're in whichever region the last `battlefieldTravel` landed them in. The algorithm continues to pretend otherwise, so:

1. Travel cost rankings are wrong from battle #2 onward (they reflect a hypothetical "what if I went home first" cost, not the real one).
2. The candidate sort (whitelisted first, then `start` ascending) ignores travel cost entirely. It can pick a battle in country C right after fighting in country A even when there are perfectly good A-vs-X battles still in the pool.
3. Per-hop budget (`ERP_FARM_MAX_TRAVEL_CC`) is checked against the wrong number, so battles get incorrectly skipped or incorrectly accepted.

The retry count of 5 (`ERP_FARM_MAX_ATTEMPTS`) is also tight in practice — "Not enough energy" cooldowns and transient deploy errors regularly chew through 3-4 attempts before the hit lands, and we lose battles to that.

---

## 3. Algorithm: cluster-by-country with 1-step lookahead

### 3.1 Pseudocode

```
state = {
  regionId:  residenceRegionId,
  countryId: residenceCountryId,
}
remaining = candidates (already filtered by eligibility/empty/age/blocked)

while remaining not empty AND budget OK:
  next = pickNext(state, remaining)
  if next == null: break  // nothing reachable within per-hop cap

  side1, side2 = orderSides(next, state.countryId)

  travel(state.regionId → side1.region)
  fight(side1)
  state.regionId  = side1.region
  state.countryId = side1.countryId

  travel(state.regionId → side2.region)
  fight(side2)
  state.regionId  = side2.region
  state.countryId = side2.countryId

  remaining.remove(next)
```

### 3.2 `pickNext(state, remaining)`

Two-tier selection:

1. **Intra-country preference.** Filter `remaining` to battles where `state.countryId ∈ {invader, defender}`. If non-empty, within this set choose the battle whose **other** side is cheapest to reach from the side we'll fight first:

   ```
   intra.minBy(b => travel_cost(side_in_current_country.region → other_side.region))
   ```

   This is the 1-step lookahead — it makes "after the cheap first hop, the second hop is also cheap" the tiebreaker. We do not look two battles ahead.

2. **Bridge to next cluster.** If `intra` is empty, pick from all remaining the battle with the cheapest single hop from current location to either of its sides:

   ```
   remaining.minBy(b => min(
     travel(state.regionId → invader_region(b)),
     travel(state.regionId → defender_region(b))
   ))
   ```

In both tiers, **any battle whose required first hop exceeds `ERP_FARM_MAX_TRAVEL_CC` is excluded entirely.** If after exclusion no candidate survives, `pickNext` returns null and the run stops with a clear log line.

### 3.3 `orderSides(battle, currentCountryId)`

- If `currentCountryId == battle.invaderId` → fight invader first (zero/cheap hop into existing country), then defender.
- Else if `currentCountryId == battle.defenderId` → fight defender first, then invader.
- Else (bridging case, neither side matches) → fight whichever side is cheaper to reach from `state.regionId` first, then the other.

### 3.4 Why 1-step lookahead, not deeper

`remaining` is typically 3-7 candidates after filters. Full TSP would need an N×N travel cost matrix, i.e. O(N²) `travelData` API calls per battle, which both adds latency and increases rate-limit risk. 1-step lookahead is O(N) calls per battle and captures ~95% of the savings of TSP in the typical case. If post-implementation measurements show cluster-by-country is consistently ≥20% above optimal, revisit.

---

## 4. State model

In-process only. No persistence between runs (one `npm run farmer` pass is self-contained):

```typescript
interface RoutingState {
  regionId: number;
  countryId: number;
  totalTravelCC: number;        // diagnostic only, no cap
  hops: Array<{
    from: number;                // regionId
    to: number;                  // regionId
    cost: number;
    battleId: number;
    side: 'invader' | 'defender';
  }>;
}
```

`totalTravelCC` and `hops` are written to logs at end of run, not used for control flow. They exist so the operator can verify the algorithm is doing what it claims.

Initial state is derived from `extractCitizenContext`:

- `regionId = raw.residenceRegionId` (already extracted today)
- `countryId = raw.residenceCountryId` — **needs to be added** to the citizen-context extractor. Use the country that owns the residence region (the page already exposes this via `erepublik.citizen.countryLocation` or `SERVER_DATA.citizen.countryLocationId`; pick whichever is more reliable — verify in `browser/session.ts`).

If `residenceCountryId` is genuinely unavailable, fall back to `info.countryId` (citizenship country) and log a warning. The two usually match for non-traveling players.

---

## 5. Implementation plan

### 5.1 Files modified

| File | Change |
|------|--------|
| `src/browser/session.ts` | Extend `extractCitizenContext` to also return `residenceCountryId`. |
| `src/farmRunner.ts` | Replace the linear `for (const c of candidates)` loop with a `while` loop driven by `RoutingState`. New `pickNext()` and `orderSides()` helpers. Default `ERP_FARM_MAX_ATTEMPTS` 5 → 10. |
| `src/tools/farm.ts` | No code changes. (`findCheapestTravelRegion` already accepts `fromRegionId` — we'll just stop passing residence and pass the live region.) |
| `src/farmOne.ts` | No changes — single-battle mode has no routing decisions. |

`src/farmRunner.ts` will grow modestly. If the routing logic crosses ~80 lines, extract `pickNext`/`orderSides` into a new `src/farm/routing.ts` to keep `farmRunner.ts` focused on the run loop. Decide during implementation, not now.

### 5.2 New env vars

None. Existing `ERP_FARM_MAX_TRAVEL_CC` is reinterpreted as **per-hop** cap (was de-facto per-hop already, but now consistently from current location, not residence).

### 5.3 Default change

```diff
- ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
+ ERP_FARM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
```

Worst-case extra wall-clock per battle: ~2.5s (5 extra attempts × `ERP_FARM_RETRY_DELAY_MS=500`). Acceptable.

### 5.4 What is **not** changing

- `listFarmableBattles`, `getCitizenEligibility`, `isBattleDivisionEmpty` — discovery and filtering identical
- Eligibility/blocked-country/age filters — applied before routing, identical
- Whitelist behavior — keep "whitelisted countries jump to front of `remaining`", but only as a tiebreaker once routing has narrowed to candidates of equal cost (resolve in implementation)
- Stop conditions — `--max-battles` cap, `fuelLeft < ERP_FARM_MIN_FUEL`, `poolEnergy < TOTAL_ENERGY*2`, `ForbiddenError`, `EnergyExhaustedError` all preserved verbatim
- `farmBattleBothSides` internals — both-side deploy + verify + cancel-handoff stays identical; only the call sites change to use `RoutingState`-derived travel instead of `info.residenceRegionId`-derived travel

---

## 6. Logging

Each battle line, instead of today's:

```
🎯 battle 5234 PL-Mazovia (Inv 11 vs Def 12) | travel inv=23cc def=45cc
```

becomes:

```
🎯 #5234 PL-Mazovia (Inv 11=PL vs Def 12=DE) | location=PL → fight PL side (0cc) → DE side (45cc) | total=178cc
```

End-of-run summary gains two lines:

```
hops: 8 (invader: 4, defender: 4)
sequence: PL → PL → DE → DE → DE → SE → SE → PL  (total 178cc)
```

The sequence string is built from `RoutingState.hops`. If a single-character country code is unavailable, fall back to the numeric ID — don't block the feature on having a country-name lookup.

---

## 7. Validation

No automated tests (no test runner is wired up in this repo, per `CLAUDE.md`). Validation is manual:

1. **Dry-run inspection.** `npm run farmer` (no `--execute`) should produce a sequence log that:
   - starts in residence country (or its closest neighbor if no candidates there)
   - shows monotonically non-decreasing total CC
   - does not jump to a country it has already left and re-entered (acceptable on rare bridging, suspicious if frequent)

2. **Compared run.** Pick a day with ≥5 candidates, run with the **old** code (git stash) and the **new** code back-to-back (or compute travel costs for the old order on paper). New algorithm's `totalTravelCC` should be at least 30% lower in any run with ≥3 country switches.

3. **Edge cases:**
   - `candidates` is empty after filters → log + clean exit, no crash
   - All candidates exceed per-hop cap from residence → log "no reachable battles within ERP_FARM_MAX_TRAVEL_CC" + clean exit
   - Single candidate → algorithm should still work; degenerates to the current behavior for that one battle
   - `Forbidden` mid-run → still aborts the entire run (preserved)
   - `extractCitizenContext` returns no `residenceCountryId` → warning logged, falls back to citizenship country, run continues

4. **Retry bump verification.** Inspect a run's logs: any battle that previously aborted at "exhausted 5 attempts" should now either succeed or get past attempt 5 with a clear last-message reason.

---

## 8. Out of scope (explicit YAGNI)

| Item | Why deferred |
|------|--------------|
| LLM-based battle selection | User explicitly asked to defer until deterministic baseline is proven. Current Phase 4 spec in `2026-05-14-erepublik-agent-design.md` still applies for the eventual "battle-selector subagent" — this design does not preclude it. |
| Full TSP routing | 1-step lookahead expected to capture ~95% of savings; revisit only if measurements show otherwise. |
| Total-pass travel budget (vs. per-hop) | Per-hop cap is sufficient defense for now; runaway costs would still trigger "no reachable battles" stop. |
| Cross-run routing memory | Each `farmer` pass starts from residence. Persisting last-known location across days adds complexity without clear win — eRepublik day rollover, manual interventions, and ~24h gaps make stale state risky. |
| New MCP tools / agent allow-list expansion | Farming stays operator-only by design (`CLAUDE.md` calls this out explicitly). Adding any farming tool to `agent/tools.ts` is a separate, deliberate decision. |
| Country-code → name lookup | Numeric IDs in logs are fine for MVP; pretty names are cosmetic. |

---

## 9. Future work this spec is shaped for

- **LLM as battle-selector** (Phase 4 in original design) — would slot in by replacing `pickNext()` with a Claude call. Inputs and outputs already small and structured (a list of ≤7 candidate descriptors → one chosen ID), which keeps tokens minimal. The deterministic algorithm becomes the fallback when LLM is unavailable or vetoes.
- **Travel cost matrix cache** — if measurements show `findCheapestTravelRegion` is the latency bottleneck, cache `(fromRegion, toCountry) → cost` for the duration of a run. The lookahead step queries it.
- **Greedy nearest-next / TSP** — both can replace `pickNext()` without touching the run loop.

---

## 10. Acceptance criteria

This spec is "done" when, on a live `npm run farmer -- --execute` pass with ≥3 candidates spanning ≥2 countries:

- [ ] `RoutingState.hops` log shows the recorded sequence and per-hop costs
- [ ] No battle is fought that required a single hop > `ERP_FARM_MAX_TRAVEL_CC` from current location
- [ ] At least one battle was fought "intra-country" with the side adjacent to current location chosen first
- [ ] Total CC for the pass is lower than what the old algorithm would have spent (verified by replaying candidate order on paper or a one-off comparison run)
- [ ] At least one battle that previously failed at attempt 5 now either succeeds or fails with a non-energy reason
- [ ] All existing stop conditions still trigger correctly (manually inducible: tight fuel, blocked country, force-Forbidden by hitting too fast)

---

## 11. Open questions for the implementation plan

To be resolved when invoking `writing-plans`:

- Should `pickNext()` go in `src/farm/routing.ts` (new file) or stay inline in `farmRunner.ts`? Decide based on actual size after writing.
- Where exactly in `extractCitizenContext` to read `residenceCountryId` — `erepublik.citizen.countryLocation` vs `SERVER_DATA.citizen.countryLocationId`. Need a quick page inspection.
- Whitelist-country interaction with cluster-by-country: should whitelisted countries be a hard prefer (always picked first if reachable), or a tiebreaker (only when costs tie)? Default to tiebreaker; revisit if the operator complains.
