# Outer-Loop Candidates

> **Work item:** AH-0MVTE4EOS008RMQ7 — Add Candidate D (Hangar War) and the discovery-progression rules
> **Parent:** AH-0MVNSSY9L001P1CC — We need an outer loop
> **Slices (complete):** AH-0MVRNIWHG0099ZS3 (framing + guard), AH-0MVRNJ0SL000RNHR (candidates + comparison), AH-0MVRNJ6BB009IGZX (cross-links + verification)
> **Status:** **Candidate D chosen (2026-10-29); phase A — the hangar slice, Candidate B's MVP — is shipped and specified in GDD §8.1; phase B (the first hex ring) is in build.** Build-out: AH-0MVU3VNJI00066YE

This document is the decision-ready catalogue of candidate **outer loops** for
AI_Hell. Four candidates are written up on the same footing. The producer
**chose Candidate D — Hangar War on 2026-10-29**; the choice is recorded in the
[Producer decision record](#producer-decision-record), summarised in GDD §8, and
scheduled by work item **AH-0MVU3VNJI00066YE** (build the hangar slice first,
then the first hex ring).

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

## Progression rules common to every candidate

Two rules apply to **all four candidates** below. They are requirements, not
options, and each candidate states how it complies in its own **Progression
rules** subsection.

**Rule 1 — start small, discover the rest.** Every version starts the player
with a **reduced set of power-ups and upgrades**: the fleet the player brings
into a run is minimal, so new hulls, starting weapons and modifiers arrive
through play instead of being handed out on first boot, and the middle loop keeps
surprising a player hours in.

**Scope of the reduction — what "reduced" does *and* does not mean.** The
reduction is in the **fleet the player owns before a run**, never in the shipped
run itself. A run still uses the whole shipped middle loop unchanged: the **six
shared loadout slots** (§4.4, any mix of power-up and weapon kinds) plus the two
**slot-free** kinds, **Extra Life** and **Mystery UFO** — so a player still builds
a **variety of six upgrades plus Extra Life and Mystery UFO** inside a
deployment. Stripping that variety to create the outer loop's scarcity would
gut the middle loop, which is the opposite of the intent. *Cost:* the first ten
minutes are sparser in *fleet* terms (one hull, one starting weapon), so the
opening hex must still be fun flown with the shipped run kit.

**Rule 2 — the boss wields it before you own it.** Mini-bosses can **introduce
new upgrades and weapon types** by using them against the player. An upgrade or
weapon becomes available only after the player **defeats the boss that uses
it** — the sequence is *demonstrated → survived → defeated → unlocked*. A boss
fight therefore doubles as reconnaissance: you learn what the weapon does (and
what it costs you) before you can hold it, which teaches its counter for free.
*Cost:* every new weapon needs a boss or mini-boss that demonstrates it fairly
and legibly, reusing the existing telegraph vocabulary (GDD §4.2,
`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`); a weapon must read as a threat
before it reads as a reward.

| Candidate | Rule 1 — reduced starting kit | Rule 2 — boss demonstrates, then grants |
|-----------|-------------------------------|-----------------------------------------|
| **Candidate A — Contested Regions / Home World** | Every new ship leaves home with **no upgrades** (A already rotates unupgraded ships onto the line) | A region's mini-boss demonstrates the region's signature weapon; the stationed-ship upgrade is earned by beating it |
| **Candidate B — Salvage Fleet** | The hangar starts with **one basic hull and one starting weapon**; everything else is bought | A mini-boss's weapon appears in the hangar tree only after that mini-boss has been defeated wielding it |
| **Candidate C — Signal Decode** | The codex starts **empty**, so the campaign starts plain and mutates as it is decoded | The boss's phases *are* the demonstration; each decoded rule unlocks the behaviour/weapon the player has just survived |
| **Candidate D — Hangar War** | The **fleet** starts minimal — one basic hull, one starting weapon, no hangar modifiers — while the **run** keeps the shipped kit in full: six shared loadout slots plus the slot-free Extra Life and Mystery UFO | A hex boss demonstrates the hex's new weapon; defeating it adds that weapon to the hangar for purchase |

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
| **Autonomous-pilot defence** | A fully upgraded ship can be **left in a region under an AI automated pilot** that defends it. The defence **resolves algorithmically**: a deterministic comparison of stored strength numbers (defender rating vs. attacking force × region aggression), **not** a live simulated battle — the attract bot supplies the defender's *rating*, it does not fly the engagement | Small — a pure resolver over stored numbers |
| **Stationed-ship mineral accrual** | A stationed ship's income between runs is **algorithmic** too: a per-tick arithmetic rule over the region's holdings, so the player's economy needs no simulation | Small — a per-tick arithmetic rule |
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
- **Hours-to-win:** the largest of A/B/C — a full campaign of manipulating
  factions, taking regions, stationing ships and repelling the onslaught is
  plausibly **10–20 hours** depending on map size, which is why this is called
  out as the biggest of the three territorial examples (only Candidate D, which
  wraps this war around a hangar, is larger).

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

- **Size:** the **largest** of the three original candidates (A, B and C) — a
  new map, a between-run faction model, a defence resolver and a new set of meta
  screens, on top of reusing the run. **Reduced by the producer's amendment:**
  because bot defence and mineral accrual are **algorithmic resolutions** rather
  than live simulations, the heaviest single system shrinks to a pure resolver —
  this is now a *large* candidate, not a *very large* one, though still bigger
  than B and C on its own.
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
the winner; and **one** onslaught test of the home region. Region defence,
mineral accrual and the faction fight all **resolve algorithmically** from
stored strength numbers — the slice contains **no simulation loop at all**, which
is what makes it buildable. If that slice makes "leave a ship to hold the line,
go home, come back stronger" feel good, the map can grow; if it does not, no
amount of extra regions will save it.

### Progression rules

- **Rule 1 — reduced starting kit.** Satisfied structurally: A already rotates a
  **ship with no upgrades** onto the line whenever one is stationed, so the
  campaign naturally starts each hull bare and power is rebuilt per ship.
- **Rule 2 — the boss wields it first.** A region's mini-boss demonstrates the
  region's signature weapon or upgrade as its attack pattern; the drop or
  unlock that makes a stationed ship strong enough to hold the region is earned
  by defeating it.

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

### Progression rules

- **Rule 1 — reduced starting kit.** The hangar starts with **one basic hull and
  one starting weapon** and no modifiers; every other hull, weapon and modifier
  is earned. The shipped 10-level campaign therefore opens with a deliberately
  thin loadout, and the run's own mineral/power-up economy does the rest.
- **Rule 2 — the boss wields it first.** A new weapon or upgrade is **not** in
  the hangar tree until its mini-boss has been defeated: the boss demonstrates
  it as an attack (or carries it visibly), and its defeat both **drops the core**
  that pays for the unlock and **reveals the entry** in the hangar.

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

### Progression rules

- **Rule 1 — reduced starting kit.** The codex starts **empty**, so the campaign
  starts plain and gains its variety as knowledge arrives; the player meets the
  simplest version of every system before the decoded rules complicate it.
- **Rule 2 — the boss wields it first.** This candidate is the purest form of the
  rule: the boss's phases **are** the demonstration, and each decoded rule
  unlocks the behaviour or weapon the player has just survived. Nothing in the
  codex is available before it has been used against the player.

---

## Candidate D — Hangar War

> Merges Candidate A's map war with Candidate B's hangar progression (producer
> proposal, 2026-10-29). Two outer-loop axes at once. **Design only, not
> scheduled.**

### Fantasy / pitch

The resistance has exactly one thing left worth defending: **the hangar**. It
sits at the centre of a hex-grid hell with the AI closing in from every side,
and there is no promised planet to escape to — the war is the point, and the
hangar is the home. You push out one ring at a time: take a weak hex, strip its
wreck for **salvage**, kill the boss that guards it and come home with a **new
kind of weapon for the fleet**, then leave a **bot** in the hex to hold it while
you fly the next one. The frontier does not wait: the AI at the border grows
stronger between sorties and takes back what you leave undefended, so every hex
you own is a promise you have to keep. Build the fleet, hold the ring, and the
hangar survives — that is what winning this hell looks like.

### Loop structure

- **Moment-to-moment (seconds):** unchanged — fly, dodge the formations,
  auto-fire, clear waves (GDD §2.3–2.6).
- **Run (a deployment, minutes):** warp into **one hex** and clear it. A hex
  deployment is a normal campaign slice (a level or a wave set) whose difficulty
  comes from that hex's **frontier aggression**, ending on the hex's boss.
- **Meta (hours):** **two progressions running together**:
  1. **The war on the map (Candidate A's axis):** the ring of hexes around the
     hangar, which hexes are held, which hold a **defending bot**, and how
     aggressive the frontier is.
  2. **The range of the fleet (Candidate B's axis):** the **hangar** — hulls,
     starting weapons, loadouts and permanent modifiers bought with salvage.
     The map gives the hangar its **purpose**: a better hull is what lets you
     take a harder hex, and a stronger hull is what you leave behind to hold
     one.
- **The capture cycle:** attack a **weak** neighbouring hex → collect salvage →
  defeat its **boss** → receive a **new kind of power-up or weapon** into the
  hangar → **leave a bot** (flying a hull of yours) in the hex, where it attempts
  to **defend** it.
- **What carries between runs — explicitly:** **both axes**. From B: **banked
  salvage**, unlocked **hulls / starting weapons / modifiers** and the active
  loadout. From A: the **ring state** — which hexes are held, which hull plus bot
  defends each, each hex's **frontier aggression**, and the **ring depth**. A run's
  temporary in-run loadout still dies with the ship (middle-loop semantics
  unchanged); the hangar and the ring never do.

### States

- **Win (per ring):** every hex of the current ring is held and the AI's massed
  counter-attack on the hangar is repelled — the hangar is safe and the ring is
  yours. The next ring then opens, so a "win" is the campaign's milestone, not
  its end.
- **Lose:** the **hangar falls** — the last hex is taken and the hangar's own
  defence fails. Losing a **run** never does this: the run's unbanked salvage is
  forfeit, the hangar and the ring survive (Candidate B's rule, preserved).
- **Partial progress:** a bad run still banks salvage from the checkpoints it
  reached, still **lowers that hex's aggression** (you killed defenders), and
  still leaves a bot defending what is already held.
- **Regression is possible and intended:** the frontier can **retake** a hex
  between runs, unless the player goes to the attacking neighbour and defeats
  it. Progress can therefore go backwards — the risk the ring creates — but the
  hangar never does.

### New systems required

| System | What it does | Rough size |
|--------|--------------|-----------|
| **Hangar (Candidate B)** | Salvage spend, unlock tree (hulls, starting weapons, modifiers), active loadout | Medium |
| **Salvage banking (Candidate B)** | Convert run rewards to a persistent balance at checkpoint moments; unbanked is lost on death | Small–Medium |
| **Hex ring map** | A hex grid whose first **ring** (6 hexes) surrounds the hangar; ring-by-ring growth for later expansions | Small–Medium — data + a map screen + a ring generator |
| **Frontier aggression clock** | Each between-run tick raises border aggression and lets the AI **attack a held hex**, retaking it unless the player defeats the attacking neighbour first | Small — a deterministic per-tick rule |
| **Defending bot assignment** | Leave a hull plus a **bot** in a hex; its **defence rating** derives from the hull's hangar upgrades, not from a live battle | Small |
| **Algorithmic defence resolution** | A taken hex falls or holds by comparing stored numbers (defender rating vs. attacking force × aggression) — **no simulated battle** | Small — a pure resolver |
| **Hex deployment + boss** | Reuse the run, with the hex's aggression selecting the difficulty curve and the hex's boss at the end | Small |
| **Boss-granted weapon discovery** | A hex boss demonstrates a new weapon/power-up; defeating it adds the entry to the hangar tree | Small–Medium |

### Reuse of existing systems

- **Checkpoint store (`src/core/checkpointStore.ts`)** — one payload holds the
  hangar (B) and the ring state (A), following the existing defensive-parse /
  injectable-store pattern; a defending hull's permanent levels are exactly the
  fields a checkpoint already persists.
- **Minerals / power-up levels** — the run economy is untouched; salvage is its
  persistent echo, banked at the existing checkpoint moments.
- **Leaderboard (`src/core/Leaderboard.ts`)** — per-run score is unchanged; the
  hangar can show the best-held-ring and best-score line.
- **Difficulty curves (`src/data/difficulty-curves.csv`)** — a hex's frontier
  aggression selects/perturbs the same curve, so hex difficulty needs no second
  scaling system.
- **Mini-boss rewards (`MiniBoss`, §4.4.4)** — the hex boss's
  upgrade-or-unlock reward is the discovery channel (Rule 2) as well as the
  extraction point.
- **Bot / attract mode** — the survival-first `decideBotIntent` heuristic
  supplies the **defender's rating** (it is never flown live in defence, so a
  defence cannot stall a demo), and it traverses the hangar/hex screens.

### Persistence and save model

A sketch `localStorage` payload under GDD §6.6 rules (defensive parse, no
backend). Both axes live in **one** key so a defence result can never be written
without the hangar state it depends on:

```jsonc
// ai_hell_hangar_war — corrupt/shape-mismatch/unknown version → null
{
  "version": 1,
  "seed": 123456789,               // deterministic resolution, replayable
  "hangar": {
    "bankedMinerals": 240,
    "bankedCores": 3,
    "unlockedHulls": ["hull-1", "hull-2"],
    "unlockedWeapons": ["spread", "waveLaser"],   // waveLaser granted by beating its boss
    "ownedModifiers": ["extra-life"],
    "activeHull": "hull-1",
    "activeLoadout": { "startingWeapons": ["spread"], "modifiers": [] }
  },
  "ring": {
    "ringIndex": 1,                // MVP = 1 ring; later rings append
    "hexes": [
      {
        "id": "hex-1",
        "q": 1, "r": 0,          // axial hex coordinates
        "held": true,
        "aggression": 2,          // frontier pressure, rises between runs
        "defender": {             // or null when unheld
          "hullId": "hull-1",
          "defenceRating": 7,     // derived from hangar upgrades, not a battle
          "bankedMinerals": 12
        },
        "bossDefeated": true,
        "grantedWeapon": "waveLaser"
      }
    ]
  },
  "pendingAttacks": [ { "hexId": "hex-1", "force": 9 } ],  // resolved next sortie
  "bestScore": 18200
}
```

**Migration note:** version the payload and default unknown/missing fields
safely — an older hangar-only save must load as "hangar at its last valid state,
empty ring", and a partial ring must never be discarded. A future backend can
replace storage behind the same injectable interface (§6.6).

### Session shape

- **Target run length:** one hex deployment ≈ the existing arcade run (≈5
  simulated minutes), unchanged — the hangar and the ring are outside the run.
- **Hours-to-win — an evening per ring, not a grind.** The **one-ring MVP targets
  40–60 minutes** for a semi-skilled player: six ≈5-minute deployments (≈30
  minutes) plus build/salvage time on the hangar and the cost of a few lost
  attempts. **Ring 2 is larger — 12 hexes** — so it lands at ≈60 minutes of
  deployments plus 10–40 minutes of builds and losses (**≈70–100 minutes**).
  Ring *n* holds **6 × *n* hexes**, so every later ring takes progressively
  longer: the campaign is deliberately **extendable rather than finite**, and the
  growth comes from ring size rather than from repeating one fixed tune.

### Playstyles supported

The loop must reward different ways of playing rather than one correct route:

- **The strategist.** Bosses, their strengths and weaknesses, and the weapon each
  hex grants are **known ahead** of a deployment (see *Known-ahead intel and
  anti-checklist mitigations*), so the player can plan "take that hex → I get the
  weapon that counters the boss threatening my home hex" instead of learning the
  map by losing to it.
- **The grinder.** Five of the six hexes grant strength — salvage, hull
  upgrades, better bots — so grinding the weaker hexes first makes the ring's
  hard hex safer. A player can spend as long as they like growing the fleet
  before committing to the push.
- **The completer.** Every hex has a boss, but **only one of the six holds the
  ring's new weapon — and that is the hardest hex in the ring.** A completer
  takes it early and pushes straight into the next ring (faster, but risking
  losses and an under-defended rear), or secures the entire ring first (slower,
  safer).
- **The rusher.** Pushing into the next ring with the current one only partly
  held is legal and is the aggressive line: the frontier keeps pressuring the
  hexes left behind, so speed is bought with risk.

No style is strictly dominant — the aggressive line is **faster but riskier** and
slow grinding is **safer but slower**, which is the intended trade (the 40–60
minute ring budget is where that trade has to stay live; see *Effort and risk*).

### UI / scene surface

- A **hex ring map screen**: the hangar at the centre, the ring around it, each
  hex showing held/unheld, aggression, its defending hull and any pending attack.
- The **hangar screen** (Candidate B's unlock tree) reachable from the map, so
  "what I own" and "what I hold" sit one click apart.
- A **deployment / hull-and-loadout selector** on the way into a hex.
- A **between-sortie defence report**: which hexes were attacked, which held,
  which fell, and what it would take to retake them.
- In-run play reuses `PlayScene` and every existing in-run screen unchanged.

### Gym testability and the bot

- **Pure logic in gyms:** the hangar economy, the **hex defence resolver** and
  the frontier clock are pure functions and ship in a dedicated `GymHangar` /
  `GymHexWar` scene, so `take hex → leave bot → AI attacks → hex holds or falls`
  is exercised end to end without a browser boot.
- **Parity:** a boss-granted weapon or hull is a config variant on the shared
  player weapon/boss paths, so it must run the **same code** in a gym
  (`GymFodderEnemies` / `GymBoss`) and in the game (AGENTS.md gym↔game parity).
- **Attract mode:** the bot traverses or skips every new screen — on the map it
  auto-picks the **weakest** adjacent hex, in the hangar it auto-buys the
  cheapest useful unlock (seeded), and it auto-advances the defence report.
  Because defence is **resolved algorithmically**, there is no live defence
  battle for the demo to stall in — the defending bot never needs to be flown.

### Pillar impact

- **Changes "no continue, game over is final" (GDD §4.6) at campaign level.** As
  with B, a lost **run** is still final (ship and unbanked salvage gone), while
  the hangar and the ring persist. **Additional cost unique to D:** hexes can be
  *lost* between runs, so the campaign can move backwards — a deliberate,
  legible stake rather than an accident.
- **Changes the "single final boss" pillar (GDD §3.1/§4.3).** Each hex ends on a
  boss and the ring ends on the hangar assault, so the boss becomes a recurring
  milestone rather than a single terminus. Cost: the Central AI needs a
  campaign-role decision (recurring hex boss vs. the assault's spearhead), and
  "one clean boss" is no longer the shape of the game.
- **Preserves "code-first, no backend"** — everything resolves locally and
  deterministically from seeded numbers.

### Effort and risk

- **Size:** **medium–large** — Candidate B's systems plus a *small* ring layer
  (map, frontier clock, defence resolver, discovery grants). Because hex defence
  and mineral accrual are **algorithmic** rather than simulated, this is
  materially cheaper than Candidate A while giving its war a reason to exist.
- **Failure modes that would make the loop unfun:**
  - **The frontier treadmill** — the AI retakes hexes faster than a casual
    player can hold them, so the map feels like a losing chore. Mitigation: a
    frontier tick the player can always answer (attack the neighbour), and
    aggression that grows on a schedule the defence report makes legible.
  - **Opaque defence** — a hex falls and the player cannot see why. Mitigation:
    show the numbers (defender rating vs. attacking force) in the report.
  - **Two progressions, twice the bookkeeping** — hangar plus ring becomes
    admin. Mitigation: one screen holds both, and the hangar is one click from
    the map.
  - **Power creep** — a large fleet trivialises every hex. Mitigation: the ring
    grows in difficulty with ring depth, and each boss-granted weapon arrives
    only after it has been beaten.
  - **The ring is a checklist** — six identical hexes are six chores, and a
    chore is not a war. Mitigation is **active, not cosmetic**: each hex
    publishes its boss, that boss's **strengths and weaknesses**, its aggression
    and the **exact weapon or upgrade it grants**, so the ring is a set of
    **strategic choices** made before a life is spent; the single weapon hex is
    the hardest in the ring, so one capture is materially different. Post-MVP
    content (special missions, upgraded bots with special skills) is recorded in
    *Known-ahead intel and anti-checklist mitigations*.
  - **One playstyle dominating** — if rushing is always right, grinding is
    busywork; if grinding is always right, the aggressive line is a trap. The
    ring timing budget exists to keep both lines alive, and the choice of when to
    take the weapon hex is the lever.

### Known-ahead intel and anti-checklist mitigations

The ring's biggest design risk is that it reads as a **checklist**: six identical
hexes are six chores. The armoury against that is **information first**, then
content.

**MVP — make the choice informed (in scope).** Before committing to a deployment
the player can see, for every hex: which **boss** holds it, what that boss is
**strong and weak against**, the **aggression** it is defended at, and exactly
**which weapon or upgrade it grants**. The ring stops being a queue and becomes a
set of **strategic weapon grants** — "I need the weapon that is strong against
the boss threatening my home hex, so I take *that* hex next" is a plan the player
can form before spending a life — and the one-weapon hex becomes a real decision
rather than a surprise.

Going **beyond** strategic weapon grants is **out of scope for the MVP**. The
ideas below are recorded so the loop has room to grow; they are **design only**
and none is scheduled:

- **Special missions.** Optional objective runs (escort a salvage convoy, hold a
  hex for N frontier ticks, kill a boss without losing a life) that pay a
  **special reward** instead of salvage — for example a **new hull type with
  extra hit points or extra upgrade bays**, a one-run modifier, or an extra
  defending bot.
- **Upgraded bots with special skills.** Defending bots that are **more effective
  against certain enemy or boss types** — an anti-swarm bot, an anti-armour bot,
  a bot that repairs a neighbour's defence rating — so what the player leaves
  behind is a composition decision, not a number.
- **Hex personalities.** Per-hex environmental or enemy twists (a nebula that
  slows projectiles, a boss that summons reinforcements) so no two captures play
  the same.
- **Contracts and bounties.** Posted objectives with a deadline in frontier
  ticks, giving the map its own rhythm between runs.
- **Ring landmarks.** One-off set-piece hexes per ring (a fortress hex needing two
  captures, a cache hex that pays out instead of granting a weapon).

Every idea above is judged by the same test as the loop itself: does it give the
player a **choice** — what to take, what to leave, what to risk — rather than one
more box to tick?

### Minimal first slice

**Candidate B's MVP plus one ring of hexes**: the hangar from B (one extra hull,
three unlockable starting weapons, one banked currency, one threat tier) plus a
**single ring of six hexes** around the hangar, with the algorithmic defence
resolver, one frontier tick that can retake a hex, known-ahead boss/weapon intel
for the ring, and **one boss-granted weapon on the ring's hardest hex**. The
slice is budgeted at **40–60 minutes of play for a semi-skilled player**, so "the
ring is a checklist" is answered by the plan the player forms before each
deployment, not by volume. If "take a hex, leave a bot, buy a hull, retake what
the AI stole" already feels like a war worth fighting, more rings can follow; if
it does not, B alone stands (the slice is a strict superset of B's, so nothing is
wasted).

### Progression rules

- **Rule 1 — reduced starting kit.** The **fleet** starts as B's does — one basic
  hull, one starting weapon, no hangar modifiers — and the *first* hex is taken
  with that bare fleet, so the fleet's range is earned outward from nothing. The
  **run is not reduced**: it keeps the shipped **six shared loadout slots** plus
  the two slot-free kinds, **Extra Life** and **Mystery UFO**, so the opening
  deployment is the game players already know and the scarcity lives in what the
  hangar owns between deployments.
- **Rule 2 — the boss wields it first.** A hex boss demonstrates the hex's new
  weapon or power-up against the player; defeating it both **captures the hex**
  and **adds the entry to the hangar**, where it is then bought with salvage.
  Nothing enters the fleet without being survived first.

---

## Comparison

Each criterion from *Comparison criteria* is scored for all four candidates;
the ranking here drives the **Recommendation** section below. Scores are
**High / Medium / Low** where **High is good for the project** — for
*New-system cost*, *Persistence complexity* and *Risk to the shipped campaign*,
"High" means **expensive / complex / risky**, so the lower rating is the better
one for those rows (called out in each cell).

| Criterion | Candidate A — Contested Regions | Candidate B — Salvage Fleet | Candidate C — Signal Decode | Candidate D — Hangar War |
|-----------|---------------------------------|-----------------------------|-----------------------------|--------------------------|
| Fit with the fiction | **High** — a war over territory and a home world for the humans is the fiction's natural conclusion | **Medium** — salvage/builds follow from stripped wrecks, but the "hell" itself is backdrop | **High** — decoding the AI and its rules is the fiction's core mystery | **High** — a hex frontier closing on the last hangar *is* "pilots in a digital hell", with no promised planet to escape to |
| Reuse of shipped systems | **Medium–High** — checkpoint, minerals/levels, curves, mini-boss rewards; the region war itself is all-new | **High** — checkpoint moments, minerals/levels, mini-boss rewards, curves, run unchanged | **Medium** — mini-boss/boss fragments, curves; mutations are new content | **High** — B's reusable set in full, plus the run unchanged; the ring is the only new surface |
| New-system cost (High = expensive) | **High** — region graph, faction war, autonomous defence, onslaught | **Medium** — hangar economy, hulls/loadouts | **Medium–High** — codex + a real gameplay effect per decoded rule | **Medium** — B's hangar economy plus a *small* ring layer (map, frontier clock, algorithmic defence resolver), because defence and accrual are resolved from stored numbers rather than simulated |
| Persistence complexity (High = complex) | **High** — map + ships + factions + onslaught state | **Medium** — banked balance + unlock flags | **Medium** — fragments + codex + decoded rules | **Medium** — hangar + ring in one versioned key; no simulation state to serialise |
| Session-length fit | **Medium** — the campaign can inflate a sitting; risk to the arcade run | **High** — one run stays a deployment; meta is outside the run | **High** — run shape preserved; meta is a menu | **High** — a hex deployment is exactly the existing run, and a whole ring is an evening (**40–60 minutes** for the one-ring MVP) |
| Legibility of progress | **Medium** — a map is legible if the UI is good, but faction/ship bookkeeping can be opaque | **High** — "you own X" is unmistakable | **Medium** — the codex reads as a list; "what have I learned" needs careful UI | **High** — two visible facts: the hexes you hold (a shape on screen) and the hulls you own (a list); a defence report explains any loss |
| Gym / bot testability | **Medium** — the most simulation to expose; autonomous defence needs a harness | **High** — pure economy functions | **High** — pure codex functions, but every mutation must be exercised in a gym | **High** — pure economy *and* a pure defence resolver; the defending bot never has to be flown, so a demo cannot stall in defence |
| Risk to the shipped campaign (High = risky) | **High** — replaces the run with a region campaign; may gut the 10-level campaign | **Low** — run unchanged; meta wraps it; the final boss stays | **Medium** — mutates the campaign; risks inconsistent or unfair runs | **Medium** — the run is unchanged (B's safety) and the boss stays, but hexes can be *lost* between runs (a front-loading frustration risk) and the boss becomes a recurring milestone rather than a single terminus |

## Recommendation

**Recommend Candidate D — Hangar War, built as its own minimal first slice: Candidate
B's MVP plus one ring.** It is the only candidate that gives the hangar a
**reason** and the war a **shipping order**:

- **It is B plus a small increment, not A plus B.** Because hex defence, mineral
  accrual and the faction/aggression tick are **algorithmic resolutions over
  stored numbers**, D's ring layer is a handful of pure functions — no
  simulation, no offline battle — which takes Candidate A's most expensive
  system out of the bill. D's new-system cost lands at *Medium*, not A's *High*.
- **It keeps B's safety.** The run is untouched, the ship still dies for real
  and the hangar never does; the 10-level campaign is wrapped, not replaced.
- **It supplies the purpose B lacks.** B alone answers "what do I own?"; D also
  answers "what am I doing it *for*?" — the fleet is what holds the ring around
  the hangar. That is the fiction's natural conclusion without A's wholesale
  campaign replacement.
- **It is the most legible of the four.** Progress is a shape on a screen (hexes
  held) plus a list (hulls owned), and a defence report explains any reversal
  with the numbers that produced it.
- **It is the most testable of the four.** Both axes are pure logic; the
  defending bot is never flown, so gym coverage and attract-mode traversal are
  straightforward.
- **It is extendable by construction.** Rings are the expansion unit, so future
  content grows the map without re-cutting the systems.

**Ship it in B's shape first.** D's first slice *is* B's MVP plus one ring, so
implement the hangar slice first and the ring second (see the ranked
justification). If the ring disappoints in play, B stands alone as a shippable
outer loop and nothing is wasted.

**Ranked justification for the non-recommended candidates:**

1. **Candidate D — Hangar War (recommended).**
2. **Candidate B — Salvage Fleet (second).** It is not beaten on its own merits —
   B is subsumed by D and is literally D's first slice. It ranks second because
   shipping B alone leaves the hangar without a purpose and the game without a
   war; D costs one small increment more. **Practical reading: ship B first, then
   extend it into D.**
3. **Candidate C — Signal Decode (third).** Its fiction fit is as strong as D's
   and its knowledge axis is the most original of the four, but every decoded
   rule needs a real, fair gameplay effect, which is content-heavy and
   balance-sensitive, and mutating the campaign risks inconsistent or unfair
   runs. It ranks below B/D on cost and risk, but above A because it preserves
   the arcade run shape and the single final boss.
4. **Candidate A — Contested Regions / Home World (fourth).** The producer's
   original proposal, and now materially cheaper thanks to the algorithmic
   resolution — but it is still the largest *single* commitment (a whole region
   campaign rather than a ring around a hangar), it has the least legible
   progress (faction and ship bookkeeping), and it carries the **highest risk of
   gutting the shipped campaign** by replacing the run with a campaign. Crucially
   **D is the better vehicle for exactly the same war**: D keeps A's territory
   axis, gives it a cheap algorithmic spine and a reason (the hangar), and grows
   in rings rather than arriving all at once. A is therefore superseded rather
   than dismissed — its mechanics live on inside D, and a larger map is D's
   natural expansion.

> The recommendation was a design judgement; the producer has since **chosen
> Candidate D — Hangar War (2026-10-29)**, recorded in the [Producer decision
> record](#producer-decision-record) and scheduled by work item
> **AH-0MVU3VNJI00066YE**.

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
| Candidate A — Contested Regions / Home World | not selected | 2026-10-29 | Superseded by D, which keeps A's territory axis with an algorithmic spine and a much smaller first slice |
| Candidate B — Salvage Fleet | not selected as a standalone loop | 2026-10-29 | Shipped as the **first slice** of D (the hangar); remains the standalone fallback if the ring disappoints |
| Candidate C — Signal Decode | not selected | 2026-10-29 | Strong fiction fit, but every decoded rule is new content and campaign mutation carries fairness risk |
| Candidate D — Hangar War | **accepted — chosen** | 2026-10-29 | Chosen by the producer. Build-out: **AH-0MVU3VNJI00066YE** (hangar slice first, then the first hex ring). Ring timing set at **40–60 minutes** for the one-ring MVP, with ring 2 at 12 hexes; boss/weapon strength **known ahead** is MVP; special missions and upgraded bots are post-MVP |

The producer's choice is recorded above. Writing the chosen loop into the GDD as
playable specification is the **follow-on work item**
**AH-0MVU3VNJI00066YE**; GDD §8 now records the choice and the design
adjustments agreed at the decision (ring timing, known-ahead intel, supported
playstyles, and the clarification that the shipped run loadout — six slots plus
Extra Life and Mystery UFO — is untouched).
