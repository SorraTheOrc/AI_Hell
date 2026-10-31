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
 * A deployment that ends on its hex boss resolves the capture in four steps,
 * all in one payload write:
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
 *    formula). No defender ⇒ no hold (`defender-required`), so a hex can never
 *    be "held" with nothing flying it.
 * 4. **Secure the ring.** When every hex of the current ring is held the ring
 *    is secured and the next ring opens (generated from its authored
 *    definitions — ring 2 is playable), with **no hangar assault pass**
 *    (producer decision 2026-10-30, Q2 = a).
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
} from './hangarEconomy';
import { createRingState, type HexRingDefinition } from './hexRing';
import {
  bankSalvage,
  bankedSalvageFromHangar,
  forfeitUnbankedSalvage,
  type BankedSalvage,
  type RunSalvage,
  type SalvageAmounts,
} from './salvageBanking';
import type {
  HangarState,
  HangarWarPayload,
  HexDefender,
  HexRingState,
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
 * @returns the resolved grant, or `null` when the hex has no grant.
 */
export function resolveHexGrant(
  grantId: unknown,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HexGrant | null {
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
 * Builds the defending bot left in a captured hex, or `null` when none can be.
 *
 * A bot flies a hull the fleet owns (the starter hull is owned by definition
 * via {@link ownsEntry}), and its stored `defenceRating` is derived from that
 * hull's hangar upgrades through the economy's single
 * {@link deriveDefenderRating} formula — never from a live battle.
 *
 * @param hangar — the persistent hangar (read only).
 * @param hullId — the hull the player chose to leave behind.
 * @param bankedMinerals — salvage banked at the hex by this capture.
 * @returns the defender record, or `null` when the hull is unknown/unowned.
 */
export function leaveDefender(
  hangar: HangarState,
  hullId: unknown,
  bankedMinerals = 0,
): HexDefender | null {
  const id = toId(hullId);
  if (id === null) return null;
  const entry = findHangarEntry(id);
  if (entry === null || entry.kind !== 'hull') return null;
  if (!ownsEntry(hangar, entry)) return null;
  return {
    hullId: id,
    defenceRating: deriveDefenderRating(id),
    bankedMinerals: toCount(bankedMinerals),
  };
}

/**
 * True when every hex of the ring is held — the ring's secured state.
 *
 * An empty ring is **not** secured: there is nothing to hold yet, so the next
 * ring must not open merely because the current ring has not been generated.
 *
 * @param ring — the ring to inspect.
 * @returns true when the ring has hexes and all of them are held.
 */
export function isRingSecured(ring: HexRingState): boolean {
  return ring.hexes.length > 0 && ring.hexes.every((hex) => hex.held === true);
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
 * "Ring secured = every hex of the current ring held" (producer decision
 * 2026-10-30, Q2 = a): there is no massed hangar assault pass and no extra
 * condition — the last captured hex opens the next ring immediately. The new
 * ring is generated from its authored definitions (ring 2's twelve hexes), so
 * it is playable at once.
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
  if (!isRingSecured(next.ring)) {
    return { payload: next, opened: false, ringIndex };
  }

  const nextIndex = ringIndex + 1;
  try {
    const ring = createRingState(nextIndex, definitions);
    if (ring.hexes.length === 0) {
      return { payload: next, opened: false, ringIndex };
    }
    next.ring = ring;
    return { payload: next, opened: true, ringIndex: nextIndex };
  } catch {
    // No authored next ring: stay secured rather than opening an empty ring.
    return { payload: next, opened: false, ringIndex };
  }
}

/** Why a boss victory did not capture its hex. */
export type CaptureRefusal = 'unknown-hex' | 'defender-required';

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
  /** True when the capture secured the current ring. */
  readonly ringSecured: boolean;
  /** True when securing the ring opened the next ring. */
  readonly ringAdvanced: boolean;
  /** The ring index the payload holds after the resolution. */
  readonly ringIndex: number;
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
      ringSecured: isRingSecured(next.ring),
      ringAdvanced: false,
      ringIndex: toCount(next.ring.ringIndex),
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
      ringSecured: isRingSecured(next.ring),
      ringAdvanced: false,
      ringIndex: toCount(next.ring.ringIndex),
    };
  }

  const definition = definitions.find((entry) => entry.id === hex.id);
  const grant = resolveHexGrant(definition?.grants);
  if (grant !== null) {
    next.hangar = withGrantedEntry(next.hangar, grant);
    hex.grantedWeapon = grant.grantId;
  }
  hex.held = true;
  hex.bossDefeated = true;
  hex.defender = defender;

  const ringSecured = isRingSecured(next.ring);
  const advanced = ringSecured
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
    ringSecured,
    ringAdvanced: advanced.opened,
    ringIndex: advanced.ringIndex,
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
