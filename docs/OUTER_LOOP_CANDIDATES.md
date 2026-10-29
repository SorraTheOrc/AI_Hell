# Outer-Loop Candidates

> **Work item:** AH-0MVRNJ0SL000RNHR — Author the three outer-loop candidate outlines, comparison and recommendation
> **Parent:** AH-0MVNSSY9L001P1CC — We need an outer loop
> **Status:** Design only, not scheduled

This document is the decision-ready catalogue of candidate **outer loops** for
AI_Hell. Each candidate is written up on the same footing so the producer can
compare them, choose one, and have it written into the Game Design Document
(GDD) with confidence.

> **Design only.** Nothing in this document is scheduled, and none of it
> changes gameplay: no gameplay code, no persistence-schema change and no new
> scene is implemented here. The chosen loop's GDD write-up is a follow-on work
> item. Every candidate below is therefore marked **design only, not
> scheduled**.

**Cross-references:**

- `docs/Game Design Document.md` §2.3–2.6 (inner loop), §4.4/§4.6 (middle loop,
  level progression), §6.6 (save model), §8 (future scope).
- `docs/CLASSIC_ENEMY_RESEARCH.md` and
  `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md` — the sibling research-catalogue
  pattern this document follows.
- Sibling slices of the parent item: the framing/skeleton slice
  (AH-0MVRNIWHG0099ZS3) and the cross-link/verification slice
  (AH-0MVRNJ6BB009IGZX).

---

## Loop tiers

The game has a strong inner loop and a functioning middle loop, but no outer
loop: nothing persists between runs except a leaderboard score, player settings
and a single run checkpoint, and game over is final (GDD §4.6).

| Tier | Timescale | Definition in this game | Exists today? |
|------|-----------|-------------------------|---------------|
| **Inner** | Seconds | Flying, dodging, destroying enemies and formations within a wave (GDD §2.3–2.6) | Yes |
| **Middle** | Minutes (a run) | Ship upgrading: minerals → hold-full power-up/weapon choices, levelled effects, extra lives (GDD §4.4, §4.6) | Yes |
| **Outer** | Hours (a campaign / a season) | What the player carries **between** runs and what they are ultimately trying to achieve | **No** |

---

## Comparison criteria

Every candidate below is ranked against the same eight criteria, stated here
before the candidates so the comparison is auditable:

1. **Fit with the fiction** — how naturally it follows from *pilots in a digital
   hell* and the resistance war it implies.
2. **Reuse of shipped systems** — how much of the existing campaign, mineral
   economy, checkpoint, leaderboard and difficulty curves it can build on.
3. **New-system cost** — how many systems must be built from nothing.
4. **Persistence complexity** — how much new saved state is required under the
   existing `localStorage` model (GDD §6.6).
5. **Session-length fit** — whether it respects the arcade run length the game
   already trains players for.
6. **Legibility of progress** — whether a player can see, without reading a
   wiki, what they have gained and what remains.
7. **Gym / bot testability** — whether its gameplay additions can be exercised
   in a gym scene (AGENTS.md gym↔game parity rule) and traversed by the attract
   bot without stalling.
8. **Risk of trivialising or gutting the shipped campaign** — the chance it
   makes the 10-level campaign feel like a tutorial or replaces it outright.

---

## Candidate A — Contested Regions / Home World

> The producer's proposal, recorded as proposed and **not** redesigned. Every
> named mechanic is preserved below as specified. **Design only, not
> scheduled.**

### Fantasy / pitch

The digital hell is not a corridor but a **contested map**. Rogue AI factions
have carved the underworld into regions (each with its own **AI aggression
level**) and are at war over them, and somewhere in that map is a dead,
zero-aggression region holding a planet the surviving humans could finally call
home. You are the resistance pilot who must find it and **defend all adjacent
regions** against attack by aggressive AI, keeping the approaches to it safe
until the war is won: not one clean run to a boss, but a campaign of territory
— take a region, leave a fully upgraded ship to guard it under an AI automated
pilot, warp onward, and return stronger when the AI comes for what you have
claimed.

### Loop structure

- **Moment-to-moment (seconds):** unchanged — fly, dodge the enemy formations,
  auto-fire, clear waves (GDD §2.3–2.6).
- **Run (a deployment, minutes):** fly into one region and clear its
  defenders. A region is a normal campaign slice (a level, or a wave set) with
  its own difficulty, drawn from the region's **AI aggression level**.
- **Meta (hours):** the region map. You spend the run finding and securing
  regions, defending them against aggressive AI, and eventually the home world.
- **The ship rotation:** when a region is secure you may leave the **fully
  upgraded ship in that region under an AI automated pilot**, warp home to
  collect **another ship with no upgrades**, and go out again — earning enough
  to make that new ship strong enough to be left guarding another region, one
  stationed ship at a time.
- **What carries between runs — explicitly:** the **region map state**. That is
  the per-region AI aggression level, which faction (if any) holds the region
  and how strong that faction's force is, which regions you have secured and
  which region contains the home world. Also carried: the **ships you have left
  stationed** in regions (each under an AI automated pilot) and their upgrade
  state, plus **minerals banked toward those stationed ships**. A run's
  temporary, in-run loadout (the current ship's temporary power-up stacks and
  its unspent minerals) does **not** carry — it dies with the ship, exactly as
  the middle loop already works.

### States

- **Win:** every region has successfully defended against the **massive AI
  onslaught**, the **home world is safe**, and the game is won.
- **Lose:** the home world is lost (its defending force fails the onslaught
  before it is strong enough) or the resistance is wiped out (no stationed ship
  and no owned ship survives). Because the map persists, "lose" means the
  campaign is lost, not that a single run ended; a fallen region can still be
  retaken while the home world stands.
- **Partial progress:** the map always advances something. A bad deployment
  still lowers a region's aggression level (you killed defenders), still
  damages or weakens a faction's force if it intervened, and still banks any
  minerals extracted back to a stationed ship — so a failed run makes the next
  push into that region cheaper even though it never reaches the home world.
- **What a bad run still advances:** region aggression down, faction strength
  down, stationed-ship upgrades up (banked minerals), and knowledge of the
  region layout toward the home world.

### New systems required

| System | What it does | Rough size |
|--------|--------------|-----------|
| **Region graph** | A small adjacency graph of named regions with a **limited-distance warp** (you may only warp to an adjacent region), each region carrying a rendered map node | Medium — data + a map screen |
| **Per-region AI aggression level** | Drives a region's deployment difficulty (reuses the difficulty-curve vocabulary) and how hard the region fights back on defence | Small–Medium — a per-region scalar mapped onto the existing difficulty resolver |
| **Warp budget** | A per-campaign or per-sortie limit on how far the ship can travel before it must return home | Small |
| **Factional AI warfare simulation** | Warring factions fight over a region between runs; **the winner leaves a stronger force**, so region strength changes over time | Medium — a deterministic between-run resolvers with per-faction strength |
| **Autonomous-pilot defence** | A fully upgraded ship can be **left in a region under an AI automated pilot** that defends it (reusing the existing attract bot as the defending intelligence) | Medium–Large — an offline (between-run) resolution of a defence |
| **Home world discovery + defence** | A zero-aggression region containing a planet that can **become home**; once found it must be defended | Medium |
| **Onslaught clock** | The escalating "massive AI onslaught" that eventually tests every held region and the home world | Medium |

### Reuse of existing systems

- **Checkpoint store (`src/core/checkpointStore.ts`)** — extends the existing
  `ai_hell_checkpoint` pattern (defensive parse, injectable storage) to hold the
  **region-map state** and the **stationed ships** instead of a single run; a
  stationed ship's permanent weapon/power-up levels and unlocks are exactly the
  fields a checkpoint already persists.
- **Minerals / power-up levels (`MineralHold`, weapon and power-up levels)** —
  the in-run upgrade economy is unchanged; "banking minerals toward a
  stationed ship" reuses the same mineral and permanent-level model, just
  targeted at a hull instead of the current one.
- **Leaderboard (`src/core/Leaderboard.ts`)** — a per-campaign or per-region
  score continues to flow to the existing local leaderboard; no new score
  surface is needed.
- **Difficulty curves (`src/data/difficulty-curves.csv`, `difficultySequencer`)** —
  a region's aggression level selects/perturbs the same curve the campaign
  already uses, so region difficulty needs no parallel scaling system.
- **Mini-boss rewards (`MiniBoss` / §4.4.4)** — each region's deployment ends on
  its mini-boss and its upgrade-or-unlock reward, which is exactly how a ship
  gets strong enough to be left guarding a region.
- **Bot / attract mode** — the same survival-first `decideBotIntent` heuristic
  becomes the **automated pilot** defending a region, and it traverses the map
  screens in demo mode (see *Gym testability and the bot*).

### Persistence and save model

A sketch `localStorage` payload under GDD §6.6 rules (defensive parse, no
backend), as its own key alongside the existing saves:

```jsonc
// ai_hell_regions — defensive parse: corrupt/shape-mismatch/unknown version → null
{
  "version": 1,
  "seed": 123456789,              // run-seeded RNG for deterministic resolution
  "homeWorldRegionId": "region-4" /* or null until found */,
  "onslaughtStage": 0,             // escalation clock
  "regions": [
    {
      "id": "region-4",
      "adjacentTo": ["region-2", "region-5"],
      "aggressionLevel": 0,        // 0 = the zero-aggression home-world candidate
      "controllingFaction": null,  // or a faction id
      "factionStrength": 0,
      "secured": false,
      "hasHomeWorld": true,
      "stationedShip": {           // or null
        "hullId": "hull-1",
        "weaponLevels": [{ "id": "spread", "level": 3 }],
        "powerUpLevels": [{ "id": "shield", "level": 2 }],
        "bankedMinerals": 14
      }
    }
  ],
  "ownedShips": []                 // ships at home, not yet deployed
}
```

**Migration note:** version the payload and treat any unknown/missing field as
the safe default (an earlier build's map must never crash a later one), exactly
as `checkpointStore` already does. A future backend can replace the storage
behind the same injectable interface, per the §6.6 migration note.

### Session shape

- **Target run length:** one region deployment ≈ the existing arcade run (≈5
  simulated minutes; GDD §2.7 targets survival ≈300 s), so a player can make
  map progress in a single sitting.
- **Hours-to-win:** the largest of the three — a full campaign of manipulating
  factions, taking regions, stationing ships and repelling the onslaught is
  plausibly **10–20 hours** depending on map size, which is why this is called
  out as the biggest candidate to build.

### UI / scene surface

- A **region map screen** (nodes, adjacency, aggression readouts, faction
  ownership), reachable from the main menu.
- A **warp / deploy** selector and a **stationed-ship** panel (which ship guards
  which region, its upgrades, its banked minerals).
- A **faction / aggression readout** showing what changed between runs.
- A **home-world** panel and an **onslaught** countdown.
- In-region play reuses `PlayScene` and every existing in-run screen (choice
  overlay, game over, leaderboard) unchanged.

### Gym testability and the bot

- The **region-war resolution** (aggression tick, faction fight → stronger
  winner, autonomous-defence outcome, onslaught resolution) is pure, seeded
  logic and can be exercised in a dedicated `GymRegionWar` / `GymOuterLoop`
  scene, with an in-region gameplay slice shown through the existing
  `GymFormationScene`-derived gyms (gym↔game parity, AGENTS.md).
- Any new in-region gameplay object must run the **same code** in a gym and in
  the game; the region map screens are ordinary scenes and their transitions are
  testable without a browser boot.
- **Attract mode:** the bot must be able to **traverse or avoid** every new
  outer-loop screen. On the map it auto-picks the adjacent region that advances
  the campaign (or the only legal warp); on the stationed-ship panel it
  auto-confirms/auto-skips; on the home-world/onslaught screens it auto-advances.
  The defending **autonomous pilot** is the same bot, so a defending region is
  played by identical code whether a human is watching or not.

### Pillar impact

- **Changes the "no continue, game over is final" pillar (GDD §4.6).** This is
  the biggest pillar change of the three: losing a run no longer ends the
  campaign, because the **map persists**. Rationale: that is the point of an
  outer loop. Cost: the arcade stakes are softened — so the *run* should stay a
  final arcade run (you lose the current ship and its unbanked loadout, and a
  region can still fall), and only the **campaign** persists. Stated
  explicitly because it must be a deliberate choice, not an accident.
- **Changes the "single final boss" pillar (GDD §3.1/§4.3).** The Central AI is
  no longer the single terminus; the **massive onslaught** and the defence of
  the home world become the campaign's climax. Cost: either the final boss is
  reused as the onslaught's spearhead or a new onslaught encounter is built;
  either way the "one clean boss" shape changes.

### Effort and risk

- **Size:** the **largest** of the three — a new map simulation, a between-run
  faction model, an autonomous-defence resolver and a new set of meta screens,
  on top of reusing the run.
- **Failure modes that would make the loop unfun:**
  - The simulation is **opaque** — the player cannot see *why* a region fell or
    a faction grew, so map changes feel arbitrary.
  - **Autonomous defence is unfun** — losing progress while not playing (the
    classic "offline raids" frustration) if the defence resolution is not
    legible or not fair.
  - **Repetition** — the same deployment-to-region loop over and over with only
    a difficulty scalar changing.
  - **Bookkeeping tedium** — too many regions and ships to manage for an arcade
    game's pacing.

### Minimal first slice

The smallest version that proves the loop is fun: **three regions** in a line
(A–B–C), with **one** zero-aggression home-world candidate at the end; a single
**aggression-level** scalar per region driving the existing difficulty curve;
**one** stationable ship with its checkpoint-persisted upgrades; **one** faction
that fights over the middle region between runs and leaves a stronger force to
the winner; and **one** onslaught test of the home region. If that slice makes
"leave a ship to hold the line, go home, come back stronger" feel good, the map
can grow; if it does not, no amount of extra regions will save it.

---

## Candidate B — Salvage Fleet

> Resource-persistent meta. **Design only, not scheduled.**

### Fantasy / pitch

The resistance does not have a fleet — it has **salvage**. Every wreck is
material; every mini-boss core is the brain of a better weapon. You are not
holding territory, you are **building the fleet that will make the final
assault possible**: strip the hell, bank what you strip, and turn it into
hulls, starting weapons and permanent modifications in a hangar that outlives
every run. The map never changes; the thing that changes is **what you own**.

### Loop structure

- **Moment-to-moment (seconds):** unchanged (GDD §2.3–2.6).
- **Run (a deployment, minutes):** fly one run in **one chosen hull** with its
  hangar-bought starting weapons and modifiers; the run is the existing
  campaign/level slice.
- **Meta (hours):** the **hangar**. Spend banked salvage between runs to unlock
  hulls, starting weapons and permanent modifiers.
- **What carries between runs — explicitly:** **banked salvage** (minerals and
  mini-boss **AI cores**, extracted at the existing checkpoint moments) and the
  **hangar unlocks** (hulls, starting weapons, permanent modifiers). This is a
  **resource/build** persistence axis: what you *own*, not where you are.
  Losing a run **forfeits that run's unbanked salvage but never the hangar** —
  the hangar is the permanent layer, and the unbanked salvage is the risk you
  carry mid-run.

### States

- **Win:** assemble a fleet strong enough to complete the **final assault run
  at maximum threat** — a single, final deployment flown with the best hull and
  loadout the fleet can field.
- **Lose:** a run ends (you lose that run's unbanked salvage). The campaign is
  not lost; you rebuild from the hangar. Only a *failed final assault* sets the
  campaign back, and even then the hangar remains.
- **Partial progress:** a bad run still **banks anything extracted at the
  checkpoint moments it reached** (mini-boss cores are the natural extraction
  points), so even a short run advances the hangar — the "never lose the
  hangar" rule guarantees a bad run is never wasted.
- **What a bad run still advances:** banked salvage (from reached checkpoints),
  mini-boss cores, and therefore hangar progress.

### New systems required

| System | What it does | Rough size |
|--------|--------------|-----------|
| **Banked salvage + extraction** | Convert run rewards into a persistent balance at checkpoint moments; unbanked salvage lost on death | Small–Medium |
| **Persistent hangar** | A menu where salvage is spent; owns the unlock tree | Medium |
| **Hulls** | Distinct starting hulls with different base stats/slots, bought in the hangar | Small–Medium (data + selection) |
| **Starting weapons** | Weapons chosen in the hangar and equipped at run start | Small (reuses the weapon catalogue) |
| **Permanent modifiers** | Hangar-bought run-wide modifiers (e.g. +1 starting life, faster recharge) | Small–Medium |
| **Threat-tier ladder for the final assault** | The escalation that ends in a maximum-threat assault run | Small |

### Reuse of existing systems

- **Checkpoint store (`src/core/checkpointStore.ts`)** — the **extraction
  moments** are the existing mini-boss checkpoints; the hangar payload follows
  the same defensive-parse/injectable-store pattern.
- **Minerals / power-up levels** — the run's mineral economy is unchanged; the
  banked balance is the *persistent* echo of it, and the mini-boss
  upgrade-or-unlock reward (§4.4.4) already produces the "cores" that get
  banked.
- **Leaderboard (`src/core/Leaderboard.ts`)** — per-run score continues to the
  existing leaderboard; the hangar can also show a best-fleet/best-score line.
- **Difficulty curves (`src/data/difficulty-curves.csv`)** — the threat tiers
  are the same curve vocabulary; the final assault is the curve at its maximum.
- **Mini-boss rewards** — their upgrade-or-unlock choice is reused for the run
  and their defeat is the extraction point.
- **Bot / attract mode** — the bot can bank salvage, buy a hangar upgrade and
  pick a hull in demo mode (see *Gym testability and the bot*).

### Persistence and save model

A sketch `localStorage` payload under GDD §6.6 rules (defensive parse, no
backend):

```jsonc
// ai_hell_hangar — defensive parse: corrupt/shape-mismatch/unknown version → null
{
  "version": 1,
  "bankedMinerals": 240,
  "bankedCores": 3,
  "unlockedHulls": ["hull-1", "hull-2"],
  "unlockedStartingWeapons": ["spread", "waveLaser"],
  "ownedModifiers": ["extra-life", "fast-recharge"],
  "activeHull": "hull-2",
  "activeLoadout": { "startingWeapons": ["spread"], "modifiers": ["extra-life"] },
  "threatTierCleared": 2,          // progress toward the final assault
  "bestScore": 18200
}
```

**Migration note:** version the payload and default unknown/missing fields
safely; a hangar written by an earlier build must load as "owned set at its last
valid state" rather than being discarded, so no player loses unlocks on an
upgrade.

### Session shape

- **Target run length:** one deployment ≈ the existing arcade run (≈5 simulated
  minutes), unchanged — the run shape is deliberately preserved.
- **Hours-to-win:** a fleet assembled over roughly **20–40 runs**, plausibly
  **8–12 hours** to a maximum-threat final assault.

### UI / scene surface

- A **hangar scene** (unlock tree: hulls, starting weapons, modifiers; banked
  balance; purchase).
- A **deployment / hull-and-loadout selector** on the way into a run.
- A **threat-tier selector** for the final assault.
- A **salvage-extracted** summary on the game-over screen (what banked, what was
  lost).
- In-run play reuses `PlayScene` and all existing in-run screens unchanged.

### Gym testability and the bot

- The **hangar economy** (banking, costs, unlock validity, loadout resolution)
  is pure logic and ships in a dedicated `GymHangar` / `GymOuterLoop` scene; the
  in-run gameplay is exercised by the existing formation gyms. Any new hull or
  modifier must run the **same code** in a gym and in the game (gym↔game
  parity), and a hull is just a player-config variant, not a divergent ship.
- **Attract mode:** the bot must **traverse or skip** the hangar and deploy
  screens — auto-buy the cheapest useful unlock (seeded RNG), auto-select a
  hull, and skip the threat-tier screen unless a final assault is legal.

### Pillar impact

- **Preserves the "no continue, game over is final" pillar (GDD §4.6) at the run
  level.** The *run* stays final — you lose the ship and its unbanked salvage —
  while the hangar persists. Rationale: this is the least disruptive way to add
  an outer loop, because it changes what you *own*, never how a run plays.
- **Preserves the single final boss (GDD §3.1/§4.3).** The final assault is the
  same Central AI encounter, reached with a fleet rather than a first-try ship;
  the boss is not replaced. Cost: the encounter must be reachable by a
  maxed-fleet player without trivialising, so it may need a threat-scaled
  variant.

### Effort and risk

- **Size:** medium — a hangar/economy layer plus hull/loadout selection, with
  the run and its content reused almost entirely.
- **Failure modes that would make the loop unfun:**
  - **Power creep trivialises the campaign** — hangar unlocks make the shipped
    10 levels a walkover instead of a challenge.
  - **Banking becomes a grind** — the optimal play is to farm the first
    checkpoint repeatedly rather than attempt a deeper run.
  - **The final assault is just the same run again** — no meaningful payoff for
    the fleet you built.

### Minimal first slice

**One** extra hull, **three** unlockable starting weapons, **one** bankable
currency (minerals banked at checkpoint moments) and **one** threat tier for a
final assault. If "lose the run, keep the salvage, buy a better ship" already
feels like progress, the tree can grow; if it does not, more unlocks will not
fix it.

---

## Candidate C — Signal Decode

> Knowledge-persistent meta. **Design only, not scheduled.**

### Fantasy / pitch

The hell is a system with rules, and rules can be **decoded**. Every mini-boss
carries a fragment of the signal that explains the AI's origin and the hell it
generates; every fragment you recover assembles a persistent **codex**. The
codex is not lore for its own sake — knowing the core's rules **changes the
campaign**: it unlocks new enemy behaviours, hellscape modifiers and shortcuts,
and the final confrontation only becomes winnable once the core has actually
been decoded. Your weapon between runs is **understanding**.

### Loop structure

- **Moment-to-moment (seconds):** unchanged (GDD §2.3–2.6).
- **Run (a deployment, minutes):** fly a run; mini-bosses and the boss drop
  **data fragments**.
- **Meta (hours):** the **codex**. Fragments assemble entries that reveal a rule
  of the system; decoded rules mutate and unlock the campaign.
- **What carries between runs — explicitly:** **information** — recovered
  fragments, decoded codex entries, and the campaign mutations/shortcuts they
  unlock. This is a **knowledge/campaign-variation** persistence axis: what you
  *understand*, not what you own and not where you are. It differs from A
  (territory) and B (owned resources) by never persisting power or place, only
  decoded rules.

### States

- **Win:** fully decode the core's rules and complete the final confrontation —
  the boss's later phases are the codex's payoff, so "won" means "understood and
  then beat it".
- **Lose:** a run ends; fragments already recovered are banked. A *failed final
  confrontation* means the codex is not yet complete enough, not that the
  campaign is lost.
- **Partial progress:** a bad run still banks the fragments of every mini-boss
  it reached, so it always advances the codex even when it dies.
- **What a bad run still advances:** fragments recovered (codex progress),
  and therefore new decoded rules / campaign mutations.

### New systems required

| System | What it does | Rough size |
|--------|--------------|-----------|
| **Data fragments** | Drops from mini-bosses/boss, persisted as codex progress | Small–Medium |
| **Persistent codex** | Entries that assemble fragments into decoded rules and lore | Medium |
| **Codex-driven campaign mutation** | Decoded rules unlock new enemy behaviours, hellscape modifiers and shortcuts | Medium–Large (each rule needs a visible gameplay effect) |
| **Decode-gated final confrontation** | The boss's later phases only become winnable once key rules are decoded | Medium |
| **Codex UI** | A browsable entries/decoded-rules/mutations surface | Medium |

### Reuse of existing systems

- **Checkpoint store (`src/core/checkpointStore.ts`)** — fragment recovery uses
  the same mini-boss checkpoint moments; the codex payload follows the same
  defensive-parse/injectable pattern.
- **Minerals / power-up levels** — the run economy is unchanged; codex rewards
  are not power, so there is no second power currency to balance.
- **Leaderboard (`src/core/Leaderboard.ts`)** — score continuity unchanged;
  the codex can show a "decode percentage" beside it.
- **Difficulty curves (`src/data/difficulty-curves.csv`)** — a decoded rule can
  apply a **hellscape modifier** to the same curve (e.g. shift the target), so
  campaign variation reuses the sequencer rather than a parallel generator.
- **Mini-boss rewards / boss (`MiniBoss` / §4.3)** — mini-bosses and the boss
  are the fragment sources, and the boss's phases are the codex's payoff; no new
  enemy family is needed.
- **Bot / attract mode** — the bot decodes entries and picks mutations in demo
  mode (see *Gym testability and the bot*).

### Persistence and save model

A sketch `localStorage` payload under GDD §6.6 rules (defensive parse, no
backend):

```jsonc
// ai_hell_codex — defensive parse: corrupt/shape-mismatch/unknown version → null
{
  "version": 1,
  "fragments": ["frag-1", "frag-3", "frag-7"],
  "decodedEntries": [
    { "id": "entry-core-rules", "decodedAt": "2026-10-29" }
  ],
  "unlockedMutations": ["ghost-flank", "dense-asteroids"],
  "discoveredShortcuts": ["level-3-skip"],
  "coreDecodedFraction": 0.35,     // gate for the final confrontation
  "bestScore": 15400
}
```

**Migration note:** version the payload and default safely; a partial codex must
load rather than be discarded, so decoded knowledge is never lost on an upgrade.

### Session shape

- **Target run length:** one deployment ≈ the existing arcade run (≈5 simulated
  minutes), unchanged.
- **Hours-to-win:** roughly **10 hours** to decode enough rules to make the
  final confrontation winnable, plus a longer final confrontation (≈10–15
  minutes).

### UI / scene surface

- A **codex scene** (fragments held, decoded entries, decoded rules, active
  mutations, discovered shortcuts).
- A **fragment-recovered** summary on the game-over screen.
- A **decode-progress** meter on the codex and the final-confrontation gate.
- In-run play reuses `PlayScene`; codex-driven mutations surface through the
  existing difficulty/sequencer seams.

### Gym testability and the bot

- The **codex assembly** (fragment → entry → decoded rule → applied mutation)
  is pure logic and ships in a dedicated `GymCodex` / `GymOuterLoop` scene; every
  **mutation must be observable in a gym** — e.g. a codex-unlocked enemy
  behaviour runs the same shared code in a gym and in the game (gym↔game
  parity), so the mutation is testable without hand-tuning the game.
- **Attract mode:** the bot decodes available entries and picks a mutation
  (seeded RNG), and skips the codex/confrontation-gate screens when nothing
  legal is available — so the demo never stalls.

### Pillar impact

- **Preserves the run-final "no continue, game over is final" pillar (GDD
  §4.6)** while adding a meta — losing a run costs its unbanked power, not the
  codex.
- **Changes the "single final boss" pillar (GDD §3.1/§4.3)** by turning it into a
  **knowledge-gated** encounter: the boss's later phases are only winnable once
  the core's rules are decoded. Rationale: it reinforces the game's own fiction
  (AI rules, a hell generated by a system) and makes mastery the gate rather
  than a gear check. Cost: it changes the boss from a pure reflex test to a
  knowledge test, and every decoded rule must have a visible, fair gameplay
  effect or the codex becomes a wiki chore.

### Effort and risk

- **Size:** medium–high — the codex itself is not huge, but every decoded rule
  needs a real, fair gameplay effect, which is content-heavy and balance-
  sensitive.
- **Failure modes that would make the loop unfun:**
  - **The codex is a chore** — reading entries to progress rather than playing
    to progress.
  - **Mutations make runs unfair or inconsistent** — a decoded modifier that
    breaks balance or makes the campaign unpredictable.
  - **The decode gate feels like a lock, not a skill** — "you cannot win until
    the counter reaches 1.0" rather than "you understand enough to win".

### Minimal first slice

**Three** fragments, **three** codex entries, **one** campaign modifier (a
hellscape modifier applied through the existing sequencer) and a decode gate on
the boss's **third phase**. If "find the fragment, decode the rule, the boss
plays differently and is now beatable" feels like progress, the codex can grow;
if it does not, more entries will not fix it.

---

## Comparison

Each criterion from *Comparison criteria* is scored for all three candidates;
the ranking here drives the **Recommendation** section below. Scores are
**High / Medium / Low** where **High is good for the project** — for
*New-system cost*, *Persistence complexity* and *Risk to the shipped campaign*,
"High" means **expensive / complex / risky**, so the lower rating is the better
one for those rows (called out in each cell).

| Criterion | Candidate A — Contested Regions | Candidate B — Salvage Fleet | Candidate C — Signal Decode |
|-----------|---------------------------------|-----------------------------|-----------------------------|
| Fit with the fiction | **High** — a war over territory and a home world for the humans is the fiction's natural conclusion | **Medium** — salvage/builds follow from stripped wrecks, but the "hell" itself is backdrop | **High** — decoding the AI and its rules is the fiction's core mystery |
| Reuse of shipped systems | **Medium–High** — checkpoint, minerals/levels, curves, mini-boss rewards; the region war itself is all-new | **High** — checkpoint moments, minerals/levels, mini-boss rewards, curves, run unchanged | **Medium** — mini-boss/boss fragments, curves; mutations are new content |
| New-system cost (High = expensive) | **High** — region graph, faction war, autonomous defence, onslaught | **Medium** — hangar economy, hulls/loadouts | **Medium–High** — codex + a real gameplay effect per decoded rule |
| Persistence complexity (High = complex) | **High** — map + ships + factions + onslaught state | **Medium** — banked balance + unlock flags | **Medium** — fragments + codex + decoded rules |
| Session-length fit | **Medium** — the campaign can inflate a sitting; risk to the arcade run | **High** — one run stays a deployment; meta is outside the run | **High** — run shape preserved; meta is a menu |
| Legibility of progress | **Medium** — a map is legible if the UI is good, but faction/ship bookkeeping can be opaque | **High** — "you own X" is unmistakable | **Medium** — the codex reads as a list; "what have I learned" needs careful UI |
| Gym / bot testability | **Medium** — the most simulation to expose; autonomous defence needs a harness | **High** — pure economy functions | **High** — pure codex functions, but every mutation must be exercised in a gym |
| Risk to the shipped campaign (High = risky) | **High** — replaces the run with a region campaign; may gut the 10-level campaign | **Low** — run unchanged; meta wraps it; the final boss stays | **Medium** — mutates the campaign; risks inconsistent or unfair runs |

## Recommendation

**Recommend Candidate B — Salvage Fleet.** It is the best-balanced outer loop:
it reuses the most shipped systems (checkpoint moments, minerals/levels,
mini-boss rewards, difficulty curves, the run itself), has the lowest new-system
cost and persistence complexity, keeps the arcade **run** and its shape intact,
and carries the **lowest risk** of trivialising or gutting the shipped campaign
while preserving the single final boss. Its progress ("you own more of the
fleet") is the most legible of the three, and its hangar economy is the easiest
to exercise in a gym and to drive with the attract bot. A resource/build axis is
also the most conventional roguelite meta, which lowers design risk.

**Ranked justification for the two non-recommended candidates:**

1. **Candidate B — Salvage Fleet (recommended).**
2. **Candidate C — Signal Decode (second).** Its fiction fit is as strong as
   A's and its knowledge axis is the most original of the three, but it is
   content-heavy: every decoded rule needs a real, fair gameplay effect, which
   is expensive and balance-sensitive, and mutating the campaign risks
   inconsistent or unfair runs. It ranks below B on cost, persistence and risk,
   but above A because it preserves the arcade run shape and the single final
   boss.
3. **Candidate A — Contested Regions / Home World (third, on cost and risk).**
   This is the producer's proposal and it has the strongest "war to win"
   fiction fit, but it is the **largest** of the three (region graph, faction
   warfare, autonomous defence, onslaught), has the most persistence
   complexity, the least legible progress (faction and ship bookkeeping), and the
   **highest risk of gutting the shipped campaign** by replacing the run with a
   region campaign. It also introduces the most new simulation to make gym-
   testable and bot-traversable, and its failure modes (opaque simulation,
   offline-defence frustration) are the hardest to discover cheaply. It should
   not be dismissed — it is the most ambitious — but it is the wrong *first*
   outer loop to ship.

> The recommendation is a design judgement, not a decision: the producer owns
> the choice, and the "Producer decision record" below is deliberately left
> pending.

## Considered but not selected

At least two further outer-loop ideas were considered and are recorded here with
a one-line deferral reason each, so the pool can be revisited later:

- **Arcade-style tiered mutator ladder** (a Hades-style "heat" ladder: beat the
  run at tier N to unlock tier N+1 with escalating, player-chosen modifiers).
  *Deferred:* it overlaps Candidate C's mutation axis and adds a large amount of
  modifier content without introducing a genuinely new persistence axis.
- **Pure daily-seed challenge ladder** (one fixed seed per day, a global ladder
  of scores per seed). *Deferred:* it is not an outer loop at all — nothing
  carries forward between runs, it depends on date seeding and (for a shared
  ladder) a backend the game does not have, and it does not answer "why come
  back after a lost run?".
- **Prestige / New Game+ survival ladder** (reset power for a permanent
  multiplier, climb a survival ladder). *Deferred:* a thin variant of the
  resource axis (B) with less fiction support, and it risks making the shipped
  campaign a stepping stone.

## Producer decision record

| Candidate | Decision | Date | Notes |
|-----------|----------|------|-------|
| Candidate A — Contested Regions / Home World | pending | — | — |
| Candidate B — Salvage Fleet | pending | — | — |
| Candidate C — Signal Decode | pending | — | — |

The producer's choice is recorded above once made. Writing the chosen loop into
the GDD as playable specification is a **follow-on work item**; this document
does not pre-empt that decision.
