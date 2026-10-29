# Outer-Loop Candidates

> **Work item:** AH-0MVRNIWHG0099ZS3 — Outer-loop document framing, skeleton and docs guard test
> **Parent:** AH-0MVNSSY9L001P1CC — We need an outer loop
> **Status:** Design only, not scheduled

This document is the decision-ready catalogue of candidate **outer loops** for
AI_Hell. Each candidate is written up on the same footing so the producer can
compare them, choose one, and have it written into the Game Design Document
(GDD) with confidence.

> **Design only.** Nothing in this document is scheduled, and none of it
> changes gameplay: no gameplay code, no persistence-schema change and no new
> scene is implemented here. The chosen loop's GDD write-up is a follow-on work
> item.

**Cross-references:**

- `docs/Game Design Document.md` §2.3–2.6 (inner loop), §4.4/§4.6 (middle loop,
  level progression), §6.6 (save model), §8 (future scope).
- `docs/CLASSIC_ENEMY_RESEARCH.md` and
  `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md` — the sibling research-catalogue
  pattern this document follows.
- Sibling slices of the parent item: the candidate-content slice
  (AH-0MVRNJ0SL000RNHR) and the cross-link/verification slice
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

> The producer's proposal, recorded as proposed and **not** redesigned.
> Design only, not scheduled.

### Fantasy / pitch

_Placeholder: one paragraph, in the game's fiction, for the region war and the
search for a home world._

### Loop structure

_Placeholder: moment-to-moment → run → meta, with an explicit statement of what
carries between runs._

### States

_Placeholder: win, lose, partial progress and what a bad run still advances._

### New systems required

_Placeholder: the named systems (region graph, aggression levels, warp, faction
warfare, autonomous pilots) with a rough size each._

### Reuse of existing systems

_Placeholder: checkpoint, minerals/power-up levels, Leaderboard, difficulty
curves, mini-boss rewards and bot/attract mode reuse._

### Persistence and save model

_Placeholder: a sketch `localStorage` payload under GDD §6.6 rules (defensive
parse, no backend) with a migration note._

### Session shape

_Placeholder: target run length and hours-to-win._

### UI / scene surface

_Placeholder: which new screens or menu entries are needed._

### Gym testability and the bot

_Placeholder: how each gameplay addition is exercised in a gym and how attract
mode completes or avoids stalling on the outer loop._

### Pillar impact

_Placeholder: which GDD pillars it changes, with rationale and cost._

### Effort and risk

_Placeholder: an honest size, plus the failure modes that would make the loop
unfun._

### Minimal first slice

_Placeholder: the smallest version that proves the loop is fun._

---

## Candidate B — Salvage Fleet

> Resource-persistent meta. Design only, not scheduled.

### Fantasy / pitch

_Placeholder: one paragraph, in the game's fiction, for the salvage fleet._

### Loop structure

_Placeholder: moment-to-moment → deployment → hangar, with an explicit statement
of what carries between runs._

### States

_Placeholder: win, lose, partial progress and what a bad run still advances._

### New systems required

_Placeholder: the named systems (banked salvage, hangar, hulls, permanent
modifiers) with a rough size each._

### Reuse of existing systems

_Placeholder: checkpoint, minerals/power-up levels, Leaderboard, difficulty
curves, mini-boss rewards and bot/attract mode reuse._

### Persistence and save model

_Placeholder: a sketch `localStorage` payload under GDD §6.6 rules (defensive
parse, no backend) with a migration note._

### Session shape

_Placeholder: target run length and hours-to-win._

### UI / scene surface

_Placeholder: which new screens or menu entries are needed._

### Gym testability and the bot

_Placeholder: how each gameplay addition is exercised in a gym and how attract
mode completes or avoids stalling on the outer loop._

### Pillar impact

_Placeholder: which GDD pillars it changes, with rationale and cost._

### Effort and risk

_Placeholder: an honest size, plus the failure modes that would make the loop
unfun._

### Minimal first slice

_Placeholder: the smallest shippable version._

---

## Candidate C — Signal Decode

> Knowledge-persistent meta. Design only, not scheduled.

### Fantasy / pitch

_Placeholder: one paragraph, in the game's fiction, for decoding the AI's
signal._

### Loop structure

_Placeholder: moment-to-moment → run → codex, with an explicit statement of what
carries between runs._

### States

_Placeholder: win, lose, partial progress and what a bad run still advances._

### New systems required

_Placeholder: the named systems (data fragments, persistent codex, campaign
mutation) with a rough size each._

### Reuse of existing systems

_Placeholder: checkpoint, minerals/power-up levels, Leaderboard, difficulty
curves, mini-boss rewards and bot/attract mode reuse._

### Persistence and save model

_Placeholder: a sketch `localStorage` payload under GDD §6.6 rules (defensive
parse, no backend) with a migration note._

### Session shape

_Placeholder: target run length and hours-to-win._

### UI / scene surface

_Placeholder: which new screens or menu entries are needed._

### Gym testability and the bot

_Placeholder: how each gameplay addition is exercised in a gym and how attract
mode completes or avoids stalling on the outer loop._

### Pillar impact

_Placeholder: which GDD pillars it changes, with rationale and cost._

### Effort and risk

_Placeholder: an honest size, plus the failure modes that would make the loop
unfun._

### Minimal first slice

_Placeholder: the smallest shippable version._

---

## Comparison

Each criterion from *Comparison criteria* is scored for all three candidates;
the ranking here drives the **Recommendation** section below.

| Criterion | Candidate A — Contested Regions | Candidate B — Salvage Fleet | Candidate C — Signal Decode |
|-----------|---------------------------------|-----------------------------|-----------------------------|
| Fit with the fiction | _pending_ | _pending_ | _pending_ |
| Reuse of shipped systems | _pending_ | _pending_ | _pending_ |
| New-system cost | _pending_ | _pending_ | _pending_ |
| Persistence complexity | _pending_ | _pending_ | _pending_ |
| Session-length fit | _pending_ | _pending_ | _pending_ |
| Legibility of progress | _pending_ | _pending_ | _pending_ |
| Gym / bot testability | _pending_ | _pending_ | _pending_ |
| Risk to the shipped campaign | _pending_ | _pending_ | _pending_ |

## Recommendation

_Placeholder: the recommended candidate with its rationale, plus a ranked
justification for why the other two rank lower._

## Considered but not selected

_Placeholder: at least two further outer-loop ideas (for example an
arcade-style tiered mutator ladder and a pure daily-seed challenge ladder) with
a one-line deferral reason each._

## Producer decision record

| Candidate | Decision | Date | Notes |
|-----------|----------|------|-------|
| Candidate A — Contested Regions / Home World | pending | — | — |
| Candidate B — Salvage Fleet | pending | — | — |
| Candidate C — Signal Decode | pending | — | — |

The producer's choice is recorded above once made. Writing the chosen loop into
the GDD as playable specification is a follow-on work item; this document does
not pre-empt that decision.
