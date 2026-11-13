/**
 * The capture cycle — the heart of the Hangar War's outer loop
 * (AH-0MVUXCAW0001VUM6, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D —
 * § *Loop structure* ("attack a weak neighbouring hex → collect salvage →
 * defeat its boss → receive a new kind of power-up or weapon into the hangar →
 * leave a bot … in the hex"), § *Progression rules* (Rule 2 — the boss wields
 * it first) and § *Persistence and save model*.
 *
 * ## What one captured hex changes
 *
 * A deployment that ends on its level's **mini-boss** (GDD §8.2: one campaign
 * level per deployment) resolves the capture in four steps, all in one payload
 * write:
 *
 * 1. **Bank the salvage.** The run's cumulative salvage at the boss moment is
 *    banked through the shipped {@link bankSalvage} rule (the same
 *    checkpoint-banking semantics: only what this run earned since its last
 *    bank is added, so a replay can never double-count).
 * 2. **Grant the hex's entry (Rule 2).** The authored `grants` id is recorded
 *    on the hex (`grantedWeapon`) and added to the fleet's owned list in the
 *    hangar — weapons to `unlockedWeapons`, hulls to `unlockedHulls`, upgrades
 *    to `ownedModifiers`. Nothing enters the fleet without the boss being
 *    survived first; a fleet that has not beaten the hex can never hold the
 *    entry.
 * 3. **Leave a defending bot.** The hex is marked held **only** with a
 *    {@link HexDefender} whose rating is derived from the chosen hull's hangar
 *    upgrades ({@link deriveDefenderRating}, from the hangar economy's single
 *    formula) and whose **special skills** ({@link defenderSkillsFor},
 *    AH-0MVWZYJ740037EZ1) come from the hull flown and/or the equipped hangar
 *    modifiers. No defender ⇒ no hold (`defender-required`), so a hex can never
 *    be "held" with nothing flying it.
 * 4. **Secure the ring — and defend the hangar.** When every hex of the
 *    current ring is held the ring is secured and the AI's **massed hangar
 *    assault** is resolved from the ring's stored numbers
 *    ({@link resolveRingAssault} → `resolveHangarAssault`). A **repelled**
 *    assault wins the ring and opens the next one (generated from its authored
 *    definitions — ring 2 is playable); a **failed** assault is the
 *    hangar-falls lose state, and the whole campaign is reset
 *    ({@link resetCampaign}: hangar and ring wiped together, a fresh seed
 *    issued, `bestScore` preserved). The **rush** line (the ring's capstone
 *    held while hexes remain unheld) still opens the next ring with no
 *    assault at all (`AH-0MVUVL2O2006W4QK`, `AH-0MWEZZ9TE001577J`).
 *
 * A lost deployment is the mirror image: {@link resolveDeploymentDefeat}
 * forfeits only the salvage earned since the last bank and returns the payload
 * untouched, because "losing a run never loses the hangar or the ring"
 * (Candidate B's rule, preserved).
 *
 * Everything here is pure and injectable — no Phaser, no storage access, no
 * `localStorage` — so the cycle is equally exercisable from the gym/headless
 * harness, the tests and `PlayScene` (AGENTS.md gym↔game parity). The scene
 * writes the returned payload through the versioned store
 * (`hangarWarStore.saveHangarWarPayload`).
 *
 * @module src/core/hangarWar/captureCycle
 */

import {
  findHangarEntry,
  ownsEntry,
  deriveDefenderRating,
  resolveActiveLoadout,
} from './hangarEconomy';
import {
  FORTRESS_CAPTURE_PASSES,
  createRingState,
  ringDepth,
  type HexLandmarkId,
  type HexRingDefinition,
} from './hexRing';

export { FORTRESS_CAPTURE_PASSES } from './hexRing';
import {
  specialMissionRewardFor,
  type SpecialMissionReward,
} from './specialMission';
import {
  DEFAULT_FRONTIER_TUNING,
  heldRingDefenderSum,
  massedAssaultBase,
  resolveHangarAssault,
  type FrontierTuning,
  type HangarAssaultResolution,
} from './hexDefence';
import { createDefaultPayload } from './hangarWarStore';
import { normaliseSeed } from '../rng';
import {
  bankSalvage,
  bankedSalvageFromHangar,
  forfeitUnbankedSalvage,
  type BankedSalvage,
  type RunSalvage,
  type SalvageAmounts,
} from './salvageBanking';
import type {
  DefenceSkill,
  HangarState,
  HangarWarPayload,
  HexDefender,
  HexRingState,
  HexState,
} from './types';
import {
  HANGAR_CATALOGUE,
  type HangarEntry,
  type HangarEntryKind,
} from '../../data/hangarCatalogue';
import { BULLET_COLORS, WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';

/**
 * A hex's authored weapon/upgrade grant resolved to a hangar entry.
 *
 * The authored ids in `src/data/hexRingDefinitions.ts` are the design's
 * vocabulary; this record is the single translation into the hangar's owned
 * sets, so the capture cycle (and the hex boss's demonstration colour) never
 * each invent their own mapping.
 */
export interface HexGrant {
  /** The authored grant id (`hexRingDefinition.grants`), unchanged. */
  readonly grantId: string;
  /** The id recorded in the hangar's owned set (catalogue id when known). */
  readonly entryId: string;
  /** Which owned set the entry belongs to. */
  readonly kind: HangarEntryKind;
  /** The shipped weapon id the boss demonstrates, or `null` for non-weapons. */
  readonly weaponId: WeaponId | null;
}

/**
 * Authored grant ids that are aliases of a shipped hangar catalogue entry.
 *
 * The ring data uses the design's spelling (`waveLaser`, `extra-life`); the
 * hangar catalogue uses its own ids (`wave_laser`, `hardened_plating`). They
 * name the same entry, so the alias table keeps one entry from appearing twice
 * in the fleet.
 */
const GRANT_ALIASES: Readonly<
  Record<string, { entryId: string; kind: HangarEntryKind; weaponId?: WeaponId }>
> = Object.freeze({
  waveLaser: Object.freeze({
    entryId: 'wave_laser',
    kind: 'weapon' as const,
    weaponId: 'wave_laser' as const,
  }),
  'extra-life': Object.freeze({
    entryId: 'hardened_plating',
    kind: 'modifier' as const,
  }),
});

/** `value` as a non-negative whole number; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** A trimmed, non-empty string, or `null`. */
function toId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id === '' ? null : id;
}

/** Detached copy of the payload, so a resolution never mutates its caller. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** Detached copy of a hangar, so no rule mutates the caller's state. */
function cloneHangar(hangar: HangarState): HangarState {
  return {
    ...hangar,
    unlockedHulls: [...hangar.unlockedHulls],
    unlockedWeapons: [...hangar.unlockedWeapons],
    ownedModifiers: [...hangar.ownedModifiers],
    activeLoadout: {
      startingWeapons: [...hangar.activeLoadout.startingWeapons],
      modifiers: [...hangar.activeLoadout.modifiers],
    },
  };
}

/** Whether `id` names a shipped weapon (`WEAPON_CATALOGUE` key). */
function isShippedWeapon(id: string): id is WeaponId {
  return Object.prototype.hasOwnProperty.call(WEAPON_CATALOGUE, id);
}

/**
 * Resolves an authored hex grant id to its hangar entry and shipped weapon.
 *
 * Resolution order:
 *
 * 1. the alias table (`waveLaser` → `wave_laser`, `extra-life` →
 *    `hardened_plating`);
 * 2. the shipped hangar catalogue (an authored id that is already an entry);
 * 3. a shipped weapon id (recorded as a weapon the fleet owns);
 * 4. a `hull-…` id (a hull);
 * 5. otherwise an upgrade, recorded as a hangar modifier.
 *
 * Total: a missing/blank grant resolves to `null` (the hex grants nothing), and
 * an unknown upgrade id is still recorded — never dropped — because the design
 * lets hexes grant strength the catalogue has not itemised yet.
 *
 * @param grantId — the authored `grants` value (or anything at all).
 * @param catalogue — the hangar tree to resolve against (defaults to shipped).
 * @param landmark — the hex's authored landmark; a `cache` always resolves to
 *   `null` (it pays out instead of granting, AH-0MWEW5I1F006CLCH).
 * @returns the resolved grant, or `null` when the hex has no grant.
 */
export function resolveHexGrant(
  grantId: unknown,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  landmark: HexLandmarkId | null | undefined = null,
): HexGrant | null {
  // A `cache` landmark pays out instead of granting (producer answer Q3 = a),
  // so it resolves to the **no-grant** payout however its authored `grants`
  // reads. The one-weapon-hex rule is unaffected: a cache can never *be* the
  // weapon hex (validated in `validateRingDefinitions`).
  if (landmark === 'cache') return null;
  const id = toId(grantId);
  if (id === null) return null;

  const alias = GRANT_ALIASES[id];
  if (alias) {
    return {
      grantId: id,
      entryId: alias.entryId,
      kind: alias.kind,
      weaponId: alias.weaponId ?? null,
    };
  }

  const entry = findHangarEntry(id, catalogue);
  if (entry !== null) {
    return {
      grantId: id,
      entryId: entry.id,
      kind: entry.kind,
      weaponId: entry.kind === 'weapon' ? entry.weaponId : null,
    };
  }

  if (isShippedWeapon(id)) {
    return { grantId: id, entryId: id, kind: 'weapon', weaponId: id };
  }
  if (id.startsWith('hull-')) {
    return { grantId: id, entryId: id, kind: 'hull', weaponId: null };
  }
  return { grantId: id, entryId: id, kind: 'modifier', weaponId: null };
}

/** The owned set a grant's kind lives in (the hangar economy's convention). */
function ownedListFor(hangar: HangarState, kind: HangarEntryKind): string[] {
  switch (kind) {
    case 'hull':
      return hangar.unlockedHulls;
    case 'weapon':
      return hangar.unlockedWeapons;
    case 'modifier':
      return hangar.ownedModifiers;
  }
}

/**
 * Records a grant in the fleet's hangar (Rule 2's "the entry now exists").
 *
 * Idempotent: an entry the fleet already owns is not duplicated. The input is
 * never mutated.
 *
 * @param hangar — the persistent hangar (read only).
 * @param grant — the resolved grant to record.
 * @returns a fresh hangar holding the entry.
 */
export function withGrantedEntry(
  hangar: HangarState,
  grant: HexGrant,
): HangarState {
  const next = cloneHangar(hangar);
  const owned = ownedListFor(next, grant.kind);
  if (!owned.includes(grant.entryId)) owned.push(grant.entryId);
  return next;
}

/**
 * The special skills a defending bot carries: the hull's own skill plus every
 * skill its equipped modifiers grant (AH-0MVWZYJ740037EZ1).
 *
 * The two **skill sources** the producer named (intake Q3 = A + B) may coexist on
 * one defender, so this is a union rather than a choice:
 *
 * - **the hull flown** — `HullDefinition.skill`;
 * - **a purchased modifier** — any modifier on the hangar's **active loadout**
 *   whose effect is `{ kind: 'defence-skill' }`.
 *
 * Only entries the fleet owns and the catalogue knows contribute (the modifiers
 * come from `resolveActiveLoadout`, which already filters both), and duplicates
 * collapse to the first mention by id so a hull and a modifier granting the same
 * training never double-stack.
 *
 * Total: an unknown hull, a malformed effect or a blank skill id contributes
 * nothing rather than throwing.
 *
 * @param hangar — the persistent hangar (read only).
 * @param hullId — the hull the defending bot flies.
 * @param catalogue — the unlock tree (injectable for tests).
 * @returns the defender's skills, in hull-then-modifier order.
 */
export function defenderSkillsFor(
  hangar: HangarState,
  hullId: string,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): DefenceSkill[] {
  const skills: DefenceSkill[] = [];
  const seen = new Set<string>();
  const add = (skill: DefenceSkill | undefined): void => {
    if (!skill || typeof skill !== 'object') return;
    const id = toId(skill.id);
    if (id === null || seen.has(id)) return;
    seen.add(id);
    skills.push({ ...skill, id });
  };

  const hull = findHangarEntry(hullId, catalogue);
  if (hull !== null && hull.kind === 'hull') add(hull.skill);

  for (const id of resolveActiveLoadout(hangar, catalogue).modifiers) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== 'modifier') continue;
    if (entry.effect.kind === 'defence-skill') add(entry.effect.skill);
  }

  return skills;
}

/**
 * Builds the defending bot left in a captured hex, or `null` when none can be.
 *
 * A bot flies a hull the fleet owns (the starter hull is owned by definition
 * via {@link ownsEntry}), and its stored `defenceRating` is derived from that
 * hull's hangar upgrades through the economy's single
 * {@link deriveDefenderRating} formula — never from a live battle.
 *
 * The bot's **special skills** ({@link defenderSkillsFor}) are attached as
 * stored data: the hull's own skill plus any its equipped modifiers grant, so
 * what the player leaves behind is a composition choice rather than a number
 * (AH-0MVWZYJ740037EZ1). The skill field is omitted entirely when the bot has
 * none, so a defender with no skills persists byte-for-byte as before.
 *
 * @param hangar — the persistent hangar (read only).
 * @param hullId — the hull the player chose to leave behind.
 * @param bankedMinerals — salvage banked at the hex by this capture.
 * @param catalogue — the unlock tree (injectable for tests).
 * @returns the defender record, or `null` when the hull is unknown/unowned.
 */
export function leaveDefender(
  hangar: HangarState,
  hullId: unknown,
  bankedMinerals = 0,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HexDefender | null {
  const id = toId(hullId);
  if (id === null) return null;
  const entry = findHangarEntry(id, catalogue);
  if (entry === null || entry.kind !== 'hull') return null;
  if (!ownsEntry(hangar, entry)) return null;
  const defender: HexDefender = {
    hullId: id,
    defenceRating: deriveDefenderRating(id),
    bankedMinerals: toCount(bankedMinerals),
  };
  const skills = defenderSkillsFor(hangar, id, catalogue);
  if (skills.length > 0) defender.skills = skills;
  return defender;
}

/**
 * Every hex that belongs to the ring's **current** ring index.
 *
 * A ring state accumulates hexes across rings (a rush carries the hexes it
 * skipped, `AH-0MVXSHAS100010S0`), so ring membership is read from the axial
 * coordinate through the shared {@link ringDepth} rule rather than from
 * position in the list. A ring state whose index is unusable (a hand-made
 * fixture) falls back to every stored hex, preserving the old behaviour.
 *
 * @param ring — the ring state to inspect.
 * @returns the current ring's hexes.
 */
export function currentRingHexes(ring: HexRingState): HexState[] {
  const index = Math.trunc(ring.ringIndex);
  if (!Number.isFinite(index) || index < 1) return ring.hexes;
  return ring.hexes.filter((hex) => ringDepth(hex.q, hex.r) === index);
}

/**
 * True when every hex of the **current** ring is held — the secured state.
 *
 * An empty current ring is **not** secured: there is nothing to hold yet, so a
 * ring must not count as secured merely because it has not been generated.
 * Hexes carried from an earlier ring the player rushed past are ignored: they
 * are the rush's cost, not a condition of this ring's security.
 *
 * @param ring — the ring to inspect.
 * @returns true when the current ring has hexes and all of them are held.
 */
export function isRingSecured(ring: HexRingState): boolean {
  const hexes = currentRingHexes(ring);
  return hexes.length > 0 && hexes.every((hex) => hex.held === true);
}

/**
 * The current ring's **capstone** hex: the authored `weaponHex` — the ring's
 * hardest hex and the one that grants its new weapon.
 *
 * @param ring — the ring state to inspect.
 * @param definitions — authored ring definitions.
 * @returns the capstone's persisted state, or `null` when the ring authors no
 *   capstone (or the capstone is not in the payload).
 */
export function ringCapstone(
  ring: HexRingState,
  definitions: readonly HexRingDefinition[],
): HexState | null {
  const index = Math.trunc(ring.ringIndex);
  const definition = definitions.find(
    (entry) => entry.ringIndex === index && entry.weaponHex === true,
  );
  if (definition === undefined) return null;
  return ring.hexes.find((hex) => hex.id === definition.id) ?? null;
}

/**
 * True when the next ring may open.
 *
 * The ring opens when its **capstone** (`weaponHex`) is held — the rush line
 * the design advertises ("take the weapon hex, then push into the next ring,
 * risking losses", `docs/OUTER_LOOP_CANDIDATES.md` adjustment 3). Securing
 * every hex of the ring also opens it. A ring that authors no capstone falls
 * back to the all-held rule.
 *
 * **Ring secured** still means every hex of the ring held. Since
 * `AH-0MWEZZ9TE001577J` a secured ring's capture triggers the hangar assault
 * first (`resolveHexCapture`), so this predicate is the *openable* test the
 * gate consults — not the win/loss decision itself.
 *
 * @param ring — the ring state to inspect.
 * @param definitions — authored ring definitions (may be empty).
 * @returns true when the ring is secured or its capstone is held.
 */
export function isRingOpenable(
  ring: HexRingState,
  definitions: readonly HexRingDefinition[] = [],
): boolean {
  if (isRingSecured(ring)) return true;
  const capstone = ringCapstone(ring, definitions);
  return capstone !== null && capstone.held === true;
}

/**
 * Materialises the current ring from its authored definitions when the stored
 * ring is still empty (a fresh war, or the phase-A build where the ring had not
 * been written yet).
 *
 * Never pads or discards a partial ring: a ring with any stored hexes is
 * returned unchanged. An unauthored ring (no definitions) is also returned
 * unchanged rather than fabricated.
 *
 * @param payload — the war payload (read only).
 * @param definitions — authored ring definitions.
 * @returns a detached payload whose ring has hexes when they could be generated.
 */
export function materialiseRing(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = [],
): HangarWarPayload {
  const next = clonePayload(payload);
  if (next.ring.hexes.length > 0) return next;
  const ringIndex = toCount(next.ring.ringIndex);
  try {
    const ring = createRingState(ringIndex >= 1 ? ringIndex : 1, definitions);
    if (ring.hexes.length === 0) return next;
    next.ring = ring;
  } catch {
    // An unauthored ring has nothing to generate; the hangar alone remains.
  }
  return next;
}

/** The result of securing a ring and opening the next one. */
export interface RingAdvanceResult {
  /** The payload with the next ring open (or unchanged when not secured). */
  readonly payload: HangarWarPayload;
  /** True when the next ring actually opened. */
  readonly opened: boolean;
  /** The ring index the payload now holds. */
  readonly ringIndex: number;
}

/**
 * Opens the next ring when the current one is fully held.
 *
 * Ring security (every hex of the current ring held) or the held capstone
 * (the rush line) opens the next ring. The ring-end hangar assault is a
 * **separate gate** in `resolveHexCapture` that runs first — this function
 * only advances a ring that is already won or rushed past. The new ring is
 * generated from its authored definitions (ring 2's twelve hexes), so it is
 * playable at once.
 *
 * A ring whose successor is not authored (e.g. ring 3 before its data lands)
 * stays secured and is not advanced into a ring of zero hexes.
 *
 * @param payload — the war payload (read only).
 * @param definitions — authored ring definitions (all rings, or just the next).
 * @returns the next payload and whether the ring advanced.
 */
export function openNextRing(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = [],
): RingAdvanceResult {
  const next = clonePayload(payload);
  const current = toCount(next.ring.ringIndex);
  const ringIndex = current >= 1 ? current : 1;
  if (!isRingOpenable(next.ring, definitions)) {
    return { payload: next, opened: false, ringIndex };
  }

  const nextIndex = ringIndex + 1;
  try {
    const ring = createRingState(nextIndex, definitions);
    if (ring.hexes.length === 0) {
      return { payload: next, opened: false, ringIndex };
    }
    // Carry the hexes already in the payload: a rush leaves the ring it
    // pushed past with unheld hexes, and those are never discarded (they keep
    // their held state, defending bot and aggression, so the frontier tick can
    // still resolve their defence). The new ring's own hexes are appended.
    next.ring = {
      ringIndex: nextIndex,
      hexes: [...next.ring.hexes, ...ring.hexes],
    };
    return { payload: next, opened: true, ringIndex: nextIndex };
  } catch {
    // No authored next ring: stay secured rather than opening an empty ring.
    return { payload: next, opened: false, ringIndex };
  }
}

// ── The ring-end hangar assault gate (AH-0MWEZZ9TE001577J) ──────────

/** Stream mixer that gives a ring's assault its own seeded draws. */
const HANGAR_ASSAULT_STREAM_MIX = 0x9e37_79b1;

/** Seed step that guarantees a reset campaign starts on a different seed. */
const CAMPAIGN_RESET_SEED_STEP = 0x9e37_79b9;

/**
 * The seed the ring-end hangar assault resolves from.
 *
 * Derived from the war's stored seed and the ring index — a pure function of
 * the payload, so a replay of the same campaign reproduces the same assault
 * bit-for-bit (and a replay of a *lost* assault reproduces the same reset).
 * Never wall-clock or live battle state.
 *
 * @param payload — the war payload (read only).
 * @returns the normalised 32-bit assault seed.
 */
export function hangarAssaultSeed(payload: HangarWarPayload): number {
  const ringIndex = toCount(payload.ring.ringIndex);
  return normaliseSeed(
    payload.seed ^ Math.imul(ringIndex + 1, HANGAR_ASSAULT_STREAM_MIX),
  );
}

/**
 * The ring's frontier aggression that scales the massed assault.
 *
 * `resolveHangarAssault` takes **one** aggression figure as its multiplier
 * driver, exactly as the hex resolver takes the attacked hex's aggression.
 * The hangar is assaulted by the whole ring, so its driver is the ring's
 * **average stored hex aggression** — the sum the frontier presses with
 * ({@link massedAssaultBase}), normalised per hex. Averaging (rather than
 * summing, or taking the single worst hex) keeps the multiplier in the same
 * `0…maxAggression` range the hex resolver sees, so neither a large ring nor
 * one hot hex can compound the pressure twice. Ties round up.
 *
 * Total: an empty ring, or corrupt aggressions (each collapses to `0`), is
 * `0` — never a throw.
 *
 * @param ring — the ring being assaulted (the current ring only).
 * @returns the rounded average stored aggression.
 */
export function ringAssaultAggression(ring: HexRingState): number {
  const hexes = currentRingHexes(ring);
  if (hexes.length === 0) return 0;
  const sum = massedAssaultBase({ ringIndex: ring.ringIndex, hexes });
  return Math.round(sum / hexes.length);
}

/**
 * Resolves the hangar assault the ring's final-hex capture triggers.
 *
 * A thin gate over the shared-core resolver, so the game, the gym and the
 * tests never re-derive an assault figure (gym↔game parity):
 *
 * - defender side — {@link heldRingDefenderSum}: the sum of the held hexes'
 *   stored bot ratings;
 * - attacker side — {@link massedAssaultBase}: the ring's stored aggression
 *   sum, scaled by {@link ringAssaultAggression} through the hex resolver's
 *   own `aggressionPercentPerPoint` rule and bounded seeded jitter;
 * - seed — {@link hangarAssaultSeed}.
 *
 * Only the **current ring** is consulted: hexes carried from a ring the player
 * rushed past are that ring's cost, not this ring's defence.
 *
 * @param payload — the war payload (read only).
 * @param tuning — balance knobs (defaults to the shipped frontier tuning).
 * @returns the outcome and every number behind it.
 */
export function resolveRingAssault(
  payload: HangarWarPayload,
  tuning: FrontierTuning = DEFAULT_FRONTIER_TUNING,
): HangarAssaultResolution {
  const ring: HexRingState = {
    ringIndex: payload.ring.ringIndex,
    hexes: currentRingHexes(payload.ring),
  };
  return resolveHangarAssault(
    {
      defenderSum: heldRingDefenderSum(ring),
      attackerBase: massedAssaultBase(ring),
      aggression: ringAssaultAggression(ring),
      seed: hangarAssaultSeed(payload),
    },
    tuning,
  );
}

/**
 * The seed a reset campaign starts on.
 *
 * A deterministic step from the fallen campaign's seed: "a fresh seed is
 * issued" without consulting a clock or `Math.random()`, so a replay of the
 * same loss produces the same fresh campaign, and the new campaign can never
 * silently reuse the old seed (the step is non-zero modulo 2³²).
 *
 * @param payload — the fallen campaign (read only).
 * @returns the fresh campaign's normalised seed.
 */
export function campaignResetSeed(payload: HangarWarPayload): number {
  return normaliseSeed(toCount(payload.seed) + CAMPAIGN_RESET_SEED_STEP);
}

/**
 * Resets the whole campaign — the hangar-falls lose state.
 *
 * Producer decision Q1 = B: losing the hangar wipes **both** progression axes
 * together, never partially. The reset reuses the shipped fresh-save
 * constructor ({@link createDefaultPayload}: empty hangar, empty ring, no
 * queued attacks, `frontierTick` 0) with {@link campaignResetSeed} as its seed
 * and the restart convention's `bestScore` preservation — the same shape the
 * hangar's `⟲ RESTART WAR` row builds, so there is one reset rule.
 *
 * @param payload — the fallen campaign (never mutated).
 * @returns a fresh campaign payload holding only the preserved best score.
 */
export function resetCampaign(payload: HangarWarPayload): HangarWarPayload {
  const fresh = createDefaultPayload(campaignResetSeed(payload));
  return { ...fresh, bestScore: toCount(payload.bestScore) };
}

/**
 * Why a boss victory did not capture its hex.
 *
 * `fortress-incomplete` is a *progress* refusal rather than a failure: the
 * pass was recorded and the salvage banked, but a fortress hex needs two
 * passes before it is held (AH-0MWEW5I1F006CLCH, Q3 = a).
 */
export type CaptureRefusal =
  | 'unknown-hex'
  | 'defender-required'
  | 'fortress-incomplete';

/**
 * The minerals a `cache` landmark pays out on capture, **instead of** granting
 * the hex's authored weapon/upgrade (AH-0MWEW5I1F006CLCH, Q3 = a). A single
 * explicit constant keeps the payout one authored balance decision rather than
 * a rule spread through the resolver.
 */
export const CACHE_SALVAGE_BONUS = 140;

/**
 * Everything a boss victory resolves the capture from.
 *
 * The run's scene supplies its own {@link BankedSalvage} watermark so a run
 * that already banked at checkpoints does not re-bank the same salvage; when
 * omitted the persistent balance alone is used (a fresh caller/tests).
 */
export interface HexCaptureInput {
  /** The hex whose boss was defeated. */
  readonly hexId: string;
  /**
   * The hull the player leaves behind as the defending bot, or `null`/blank
   * when none was chosen (the hex then stays unheld — `defender-required`).
   */
  readonly defenderHullId: string | null;
  /** The run's cumulative salvage at the boss-victory moment. */
  readonly salvage: RunSalvage;
  /** Authored ring definitions (for the grant and for opening the next ring). */
  readonly definitions?: readonly HexRingDefinition[];
  /** The caller's bank watermark (defaults to the stored balance). */
  readonly banked?: BankedSalvage;
  /** Assault balance knobs (a harness/test may zero the jitter). */
  readonly tuning?: FrontierTuning;
}

/** A resolved capture: the next payload and every number behind it. */
export interface HexCaptureResult {
  /** True when the hex was captured (held with a defender). */
  readonly ok: boolean;
  /** Why the hex was not captured (`null` when {@link ok}). */
  readonly reason: CaptureRefusal | null;
  /** The payload to persist (banked salvage; captured hex when {@link ok}). */
  readonly payload: HangarWarPayload;
  /** The bank watermark after the victory (the caller keeps this). */
  readonly banked: BankedSalvage;
  /** Salvage added to the persistent balance by this victory. */
  readonly bankedDelta: SalvageAmounts;
  /** The defending bot left in the hex, or `null` when none could be left. */
  readonly defender: HexDefender | null;
  /** The hex's weapon/upgrade entry granted into the hangar, or `null`. */
  readonly grant: HexGrant | null;
  /**
   * The special-mission reward this capture paid (a hull with extra hit
   * points), or `null` when the hex is an ordinary one
   * (AH-0MWF0CX0H004OJ2Y). Carried so a caller can announce the special
   * reward without re-deriving it from authored data.
   */
  readonly specialReward: SpecialMissionReward | null;
  /**
   * The contract bonus this capture banked (post-MVP Hangar War,
   * AH-0MWEW58WD003NFXS, Q2 = a), or `null` when the hex authors no contract or
   * its bonus was already banked — a replay adds nothing.
   */
  readonly contractBonus: SalvageAmounts | null;
  /**
   * The cache payout this capture banked (AH-0MWEW5I1F006CLCH, Q3 = a), or
   * `null` when the hex is not a cache or it was already held (a replay adds
   * nothing).
   */
  readonly cachePayout: SalvageAmounts | null;
  /** True when the capture secured the current ring. */
  readonly ringSecured: boolean;
  /** True when securing the ring opened the next ring. */
  readonly ringAdvanced: boolean;
  /** The ring index the payload holds after the resolution. */
  readonly ringIndex: number;
  /**
   * The hangar assault the ring's final-hex capture triggered, or `null` when
   * the capture did not secure the ring (a mid-ring capture, the rush line, a
   * refusal). Carries every number, so the defence report renders it without
   * re-derivation.
   */
  readonly assault: HangarAssaultResolution | null;
  /** True when the assault broke the hangar and the whole campaign was reset. */
  readonly campaignReset: boolean;
}

/**
 * Pays a `cache` landmark's bonus on capture, **instead of** granting
 * (AH-0MWEW5I1F006CLCH, producer answer Q3 = a).
 *
 * The payout goes through the shipped {@link bankSalvage} rule with a
 * cache-scoped run watermark, and it is only paid when the hex was **not**
 * already held: a replay of an already-captured cache adds nothing, so the
 * payout can never be double-counted. Nothing enters the fleet — a cache grants
 * no weapon, hull or modifier.
 *
 * @param payload — the detached payload being resolved (its hangar is credited).
 * @param hex — the captured hex.
 * @param definition — the authored definition, or `undefined` when unknown.
 * @param alreadyHeld — true when the hex was held before this resolution.
 * @returns the salvage paid by this call, or `null` when none was paid.
 */
function payCacheLandmark(
  payload: HangarWarPayload,
  hex: HexState,
  definition: HexRingDefinition | undefined,
  alreadyHeld: boolean,
): SalvageAmounts | null {
  if (definition?.landmark !== 'cache') return null;
  if (alreadyHeld) return null;
  if (CACHE_SALVAGE_BONUS <= 0) return null;

  const banked = bankSalvage(bankedSalvageFromHangar(payload.hangar), {
    runId: `hex-cache:${hex.id}`,
    checkpointId: hex.id,
    minerals: CACHE_SALVAGE_BONUS,
    cores: 0,
  });
  payload.hangar.bankedMinerals = banked.minerals;
  payload.hangar.bankedCores = banked.cores;
  return { minerals: CACHE_SALVAGE_BONUS, cores: 0 };
}

/**
 * Fulfils a hex's authored **contract** on capture: banks its bonus through the
 * shipped banking rule and records the fulfilment marker.
 *
 * Producer answer Q2 = a (2026-11-13): the reward is bonus salvage/cores in the
 * shipped currencies, banked like any other salvage, with **no deadline clock**.
 * The stored `contractFulfilled` marker is the replay guard — a replayed battle,
 * or a second capture of the same hex, adds nothing — and the banking itself
 * goes through {@link bankSalvage} with a contract-scoped run watermark, so the
 * whole bonus is added exactly once instead of hand-rolled.
 *
 * Mutates `payload.hangar` and `hex` in place (the caller owns a detached
 * payload).
 *
 * @param payload — the detached payload being resolved (its hangar is credited).
 * @param hex — the captured hex (receives the fulfilment marker).
 * @param definition — the authored definition, or `undefined` when unknown.
 * @returns the bonus banked by this call, or `null` when none was banked.
 */
function fulfilContract(
  payload: HangarWarPayload,
  hex: HexState,
  definition: HexRingDefinition | undefined,
): SalvageAmounts | null {
  const contract = definition?.contract;
  if (contract === undefined) return null;
  if (hex.contractFulfilled === true) return null;

  const bonus: SalvageAmounts = {
    minerals: toCount(contract.bonusSalvage),
    cores: toCount(contract.bonusCores),
  };
  if (bonus.minerals === 0 && bonus.cores === 0) return null;

  const banked = bankSalvage(bankedSalvageFromHangar(payload.hangar), {
    runId: `hex-contract:${hex.id}`,
    checkpointId: hex.id,
    minerals: bonus.minerals,
    cores: bonus.cores,
  });
  payload.hangar.bankedMinerals = banked.minerals;
  payload.hangar.bankedCores = banked.cores;
  hex.contractFulfilled = true;
  return bonus;
}

/**
 * Resolves a boss victory into a captured hex (the capture cycle's win path).
 *
 * The salvage is banked **first**, so a victory always extracts what the run
 * earned even when the hex itself cannot be held (a defensive refusal never
 * silently discards salvage). The hex is then marked held + boss-defeated +
 * granted + defended **only** when a valid defender hull was chosen; otherwise
 * the resolution reports `defender-required` and leaves the hex unheld and
 * un-granted.
 *
 * Securing the ring's **final hex** then runs the ring-end assault gate
 * (`AH-0MWEZZ9TE001577J`): the massed hangar assault is resolved from the
 * ring's stored numbers ({@link resolveRingAssault}). A **repelled** assault
 * opens the next ring (as the rush line always has); a **failed** assault is
 * the hangar-falls lose state and returns a freshly reset campaign
 * ({@link resetCampaign}) with `campaignReset: true` and an empty bank
 * watermark. The rush line — the capstone held while hexes remain unheld —
 * opens the next ring with no assault.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param input — target hex, chosen hull, salvage and ring definitions.
 * @returns the next payload plus the grant/defence/ring outcome.
 */
export function resolveHexCapture(
  payload: HangarWarPayload,
  input: HexCaptureInput,
): HexCaptureResult {
  const definitions = input.definitions ?? [];
  const next = materialiseRing(payload, definitions);
  const hexId = toId(input.hexId);

  const startingBank = input.banked ?? bankedSalvageFromHangar(next.hangar);
  const settled = bankSalvage(startingBank, input.salvage);
  const bankedDelta: SalvageAmounts = {
    minerals: Math.max(0, settled.minerals - toCount(startingBank.minerals)),
    cores: Math.max(0, settled.cores - toCount(startingBank.cores)),
  };
  next.hangar.bankedMinerals = settled.minerals;
  next.hangar.bankedCores = settled.cores;

  const hex =
    hexId === null ? undefined : next.ring.hexes.find((state) => state.id === hexId);
  if (!hex) {
    return {
      ok: false,
      reason: 'unknown-hex',
      payload: next,
      banked: settled,
      bankedDelta,
      defender: null,
      grant: null,
      specialReward: null,
      contractBonus: null,
      cachePayout: null,
      ringSecured: isRingSecured(next.ring),
      ringAdvanced: false,
      ringIndex: toCount(next.ring.ringIndex),
      assault: null,
      campaignReset: false,
    };
  }

  const defender = leaveDefender(
    next.hangar,
    input.defenderHullId,
    bankedDelta.minerals,
  );
  if (defender === null) {
    return {
      ok: false,
      reason: 'defender-required',
      payload: next,
      banked: settled,
      bankedDelta,
      defender: null,
      grant: null,
      specialReward: null,
      contractBonus: null,
      cachePayout: null,
      ringSecured: isRingSecured(next.ring),
      ringAdvanced: false,
      ringIndex: toCount(next.ring.ringIndex),
      assault: null,
      campaignReset: false,
    };
  }

  const definition = definitions.find((entry) => entry.id === hex.id);
  const wasHeld = hex.held === true;

  // A fortress hex needs two capture passes (Q3 = a): the pass is recorded and
  // the salvage already banked, but the hex is not held until the second pass.
  if (definition?.landmark === 'fortress' && !wasHeld) {
    const passes = Math.min(
      FORTRESS_CAPTURE_PASSES,
      toCount(hex.capturePasses) + 1,
    );
    hex.capturePasses = passes;
    if (passes < FORTRESS_CAPTURE_PASSES) {
      return {
        ok: false,
        reason: 'fortress-incomplete',
        payload: next,
        banked: settled,
        bankedDelta,
        defender: null,
        grant: null,
        specialReward: null,
        contractBonus: null,
        cachePayout: null,
        ringSecured: isRingSecured(next.ring),
        ringAdvanced: false,
        ringIndex: toCount(next.ring.ringIndex),
        assault: null,
        campaignReset: false,
      };
    }
  }

  // A cache pays out instead of granting, so it resolves to the no-grant
  // payout however its authored `grants` reads (Q3 = a).
  const grant = resolveHexGrant(definition?.grants, undefined, definition?.landmark);
  // A special mission pays its hull through the same grant path as any other
  // hex; the reward record only makes that payment legible to the caller.
  const specialReward = specialMissionRewardFor(definition);
  if (grant !== null) {
    next.hangar = withGrantedEntry(next.hangar, grant);
    hex.grantedWeapon = grant.grantId;
  }
  hex.held = true;
  hex.bossDefeated = true;
  hex.defender = defender;

  // The contract bonus is banked with the capture (Q2 = a) through the shipped
  // banking rule, guarded by the hex's stored fulfilment marker so a replay
  // can never double-count it.
  const contractBonus = fulfilContract(next, hex, definition);

  // A cache landmark pays its bonus instead of granting (Q3 = a); a replay of an
  // already-held cache pays nothing.
  const cachePayout = payCacheLandmark(next, hex, definition, wasHeld);

  const ringSecured = isRingSecured(next.ring);
  // The ring's final hex is captured: resolve the AI's massed hangar assault
  // from the ring's stored numbers before anything else touches the ring.
  const assault = ringSecured ? resolveRingAssault(next, input.tuning) : null;

  if (assault !== null && assault.outcome === 'fell') {
    // The hangar falls: both progression axes are wiped together and a fresh
    // campaign seed is issued — the run's banked salvage fell with the hangar,
    // so the caller's watermark restarts empty.
    const reset = resetCampaign(next);
    return {
      ok: true,
      reason: null,
      payload: reset,
      banked: bankedSalvageFromHangar(reset.hangar),
      bankedDelta,
      defender,
      grant,
      specialReward,
      contractBonus,
      cachePayout,
      ringSecured: false,
      ringAdvanced: false,
      ringIndex: toCount(reset.ring.ringIndex),
      assault,
      campaignReset: true,
    };
  }

  // A repelled assault (the ring is won) or the rush line (capstone held,
  // ring still unheld) opens the next ring; a ring that is not openable keeps
  // the payload's current ring unchanged.
  const advanced = isRingOpenable(next.ring, definitions)
    ? openNextRing(next, definitions)
    : { payload: next, opened: false, ringIndex: toCount(next.ring.ringIndex) };

  return {
    ok: true,
    reason: null,
    payload: advanced.payload,
    banked: settled,
    bankedDelta,
    defender,
    grant,
    specialReward,
    contractBonus,
    cachePayout,
    ringSecured,
    ringAdvanced: advanced.opened,
    ringIndex: advanced.ringIndex,
    assault,
    campaignReset: false,
  };
}

/** Everything a lost deployment settles from. */
export interface DeploymentDefeatInput {
  /** The run's cumulative salvage at the moment it was lost. */
  readonly salvage: RunSalvage;
  /** The caller's bank watermark (defaults to the stored balance). */
  readonly banked?: BankedSalvage;
}

/** A settled lost deployment: the unchanged war plus the forfeited salvage. */
export interface DeploymentDefeatResult {
  /** A detached, unchanged payload — the hangar and ring survive the loss. */
  readonly payload: HangarWarPayload;
  /** The bank watermark after the loss (unchanged in value). */
  readonly banked: BankedSalvage;
  /** The salvage the run forfeited (earned since its last bank). */
  readonly forfeited: SalvageAmounts;
}

/**
 * Settles a lost deployment (the capture cycle's loss path).
 *
 * "Losing a run never loses the hangar or the ring": the payload is returned
 * untouched and only the salvage earned since this run's last bank is
 * forfeited — the shipped {@link forfeitUnbankedSalvage} rule, reused rather
 * than re-implemented.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param input — the run's final salvage and the caller's bank watermark.
 * @returns the unchanged payload, the bank state and the forfeited amount.
 */
export function resolveDeploymentDefeat(
  payload: HangarWarPayload,
  input: DeploymentDefeatInput,
): DeploymentDefeatResult {
  const next = clonePayload(payload);
  const startingBank = input.banked ?? bankedSalvageFromHangar(next.hangar);
  const outcome = forfeitUnbankedSalvage(startingBank, input.salvage);
  return {
    payload: next,
    banked: outcome.banked,
    forfeited: outcome.forfeited,
  };
}

/**
 * The demonstration colour of a hex boss's granted weapon, or `null`.
 *
 * The boss "wields it first" (Rule 2), so its body is painted in the granted
 * weapon's own bullet colour — the visible cue that the reward being
 * demonstrated is the reward being earned. Non-weapon grants (a hull or an
 * upgrade) have no bullet colour and resolve to `null`.
 *
 * @param grant — the resolved grant (or `null`).
 * @returns the weapon's bullet colour, or `null`.
 */
export function grantDemonstrationColor(grant: HexGrant | null): number | null {
  if (grant === null || grant.weaponId === null) return null;
  return BULLET_COLORS[grant.weaponId];
}
