/**
 * Hangar screen — the shared, pure model plus the one renderer used by the
 * game's hangar scene and by `GymHangar` (AH-0MVUXC1X6007KAG1, part of
 * **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface — "the hangar screen (Candidate B's unlock tree) … a deployment /
 * hull-and-loadout selector on the way into a hex". Two rules shape this
 * module:
 *
 * - **No purchase logic in scene code.** Every decision (what is owned, gated,
 *   unaffordable; what is buyable; what equips) comes from the pure economy
 *   module (`src/core/hangarWar/hangarEconomy.ts`) and the catalogue
 *   (`src/data/hangarCatalogue.ts`). This module only *presents* those
 *   decisions and applies them through the shared pure updaters
 *   ({@link purchaseHangarEntry}, {@link upgradeHangarKind},
 *   {@link equipHangarHull}, {@link toggleHangarWeapon}), which return a fresh
 *   payload.
 * - **An owned level-bearing row is an upgrade row, not a dead `OWNED` one.**
 *   A weapon the fleet owns shows its current permanent level and the priced
 *   next-level action (`UPGRADE · 100 min`), visibly disabled with its price
 *   and shortfall when the fleet cannot pay and `MAX` at the shared
 *   `MAX_PERMANENT_LEVEL` ceiling. The price, cap and affordability verdicts
 *   are the economy's own pure upgrade rule (`costToUpgrade`/`buyUpgrade`,
 *   parent AH-0MWHW4ALS0039JFU — this item AH-0MWI5AK1E008HDHH); every
 *   non-upgradeable row (a hull, a modifier, a consumable, a field-pickup-only
 *   kind, and any row the fleet does not own) renders byte-identically to
 *   before. The renderer stays kind-agnostic, so a power-up level row renders
 *   the same affordance once one exists (power-up purchases seed it —
 *   AH-0MWKT12BT001106T).
 * - **The deployment is a launch, not a loadout rule.** The ▶ DEPLOY row is
 *   built from the same pure deployment payload builder the game's scene
 *   hands to `PlayScene` (`./hangarDeployment`), so the hull, starting
 *   weapons, modifiers and hex-aggression difficulty shown on the screen are
 *   exactly the ones a deployment carries (AH-0MVUXC2DD003HN0I).
 * - **The screen is target-aware (AH-0MWMT4QXF0095CBN).** When the player
 *   arrives from a chosen hex, an optional `targetHexId` is threaded into the
 *   same deployment builder, so the `▶ DEPLOY` row and the published
 *   {@link HangarBossIntel} describe **exactly** the hex the launch attacks.
 *   The intel comes from the shared authored ring data
 *   (`src/data/hexRingDefinitions.ts`, or an injectable `definitions`
 *   override), never a scene-local copy; an unknown/unauthored hex publishes
 *   an explicit unknown fallback instead of throwing. Every weapon row
 *   (the loadout selector and the unlock tree's weapon entries) also carries
 *   its {@link BossMatchup} against that boss, resolved by the F1 pure rule
 *   (`src/core/hangarWar/weaponMatchup.ts`) — **display only**, never a combat
 *   rule (parent assumption A7; AH-0MWL5376H001WJFZ owns the mechanics). The
 *   verdict is always paired with a glyph tag (`▲ EFFECTIVE` / `▼ RESISTED`),
 *   so it is readable without colour (repo CVD policy).
 * - **One screen code path.** {@link buildHangarScreenModel} and
 *   {@link renderHangarScreen} are used by the shipped `HangarScene` *and* by
 *   the `GymHangar` parity scene (which renders the same model read-only), so
 *   the gym can never drift from the game (AGENTS.md gym↔game parity,
 *   `docs/GYM_PARITY.md`). The target-aware intel and the matchup marks are
 *   part of that model, so the gym renders the identical `TARGET INTEL` block
 *   and `▲ EFFECTIVE` / `▼ RESISTED` marks read-only
 *   (AH-0MWMT4STK001PSK4).
 * - **An empty loadout is auto-fitted on open; the button is the explicit
 *   path** (AH-0MWOWEPO2004B0MR, documented by AH-0MWOWEYZQ006IR9T). The
 *   shared boss-aware selector (`selectAutoLoadout` via `applyAutoLoadout`)
 *   is the one selection rule, consumed here and by `GymHangar`. The
 *   `HangarScene` auto-fits it when the loadout is at its shipped default —
 *   exactly an empty `activeLoadout.startingWeapons`
 *   (`isDefaultHangarLoadout`), never "the selector found no strong weapon" —
 *   so a hand-picked loadout is never silently rewritten; the
 *   `⚡ APPLY SUGGESTED BUILDOUT` row (`buildHangarBuildoutRow`) is the one
 *   control that replaces it, on demand. The gym renders that same row
 *   read-only from the same model.
 *
 * The screen's two navigation/state rows — `⌗ HEX MAP` and the destructive
 * `⟲ RESTART WAR` reset — are built here too. The restart row is a two-step
 * confirm: {@link buildHangarRestartRow} renders the idle/armed label, the pure
 * {@link advanceRestartConfirm} state machine decides arm/confirm/disarm, and
 * {@link restartHangarWar} returns the fresh starting-position payload
 * (preserving `bestScore`) that the scene persists (AH-0MW8F7NH1002PQE3).
 *
 * Everything in {@link buildHangarScreenModel} and the payload updaters is
 * pure and total, so the tree, the disabled states and the attract-bot answer
 * are table-testable without booting a scene.
 *
 * @module src/scenes/hangarWar/hangarScreen
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  HANGAR_CATALOGUE,
  STARTER_WEAPON_ID,
  isPurchasableEntry,
  type HangarEntry,
  type HangarEntryKind,
  type HangarPrice,
} from '../../data/hangarCatalogue';
import {
  selectAutoLoadout,
  type AutoLoadoutSuggestion,
} from '../../core/hangarWar/hangarAutoLoadout';
import {
  applySavedBuild,
  buy,
  canBuy,
  captureShipBuild,
  cheapestUsefulUnlock,
  costToUpgrade,
  currentUpgradeLevel,
  equipHull,
  equipLoadout,
  findHangarEntry,
  hangarPermanentLevels,
  MAX_PERMANENT_LEVEL,
  MAX_SAVED_BUILD_NAME_LENGTH,
  ownedLevelBearingPowerUpLevels,
  ownsEntry,
  resolveActiveHull,
  resolveActiveLoadout,
  type SavedBuildRefusalReason,
  type SavedBuildShortfall,
  type UpgradeRefusal,
} from '../../core/hangarWar/hangarEconomy';
import {
  buyHangarUpgrade,
  createDefaultPayload,
} from '../../core/hangarWar/hangarWarStore';
import type {
  HangarLoadout,
  HangarWarPayload,
  HexRingState,
} from '../../core/hangarWar/types';
import {
  admittedDeploymentDropIds,
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarDeployment';
import { FocusManager } from '../../utils/focusManager';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { HexRingDefinition } from '../../core/hangarWar/hexRing';
import {
  resolveBossMatchup,
  type BossMatchup,
  type MatchupDefinition,
} from '../../core/hangarWar/weaponMatchup';
import {
  MATCHUP_GLYPHS,
  buildAuthoredVerdictLookup,
  matchupGlyphFor,
  resolveHexMatchup,
  type MatchupGlyph,
} from '../../core/hangarWar/hexMatchup';
import { capDropIdsToSlotPool } from '../../powerups/slots';
import { POWER_UP_CATALOGUE } from '../../powerups/types';

/** Title rendered by the hangar screen (asserted by tests). */
export const HANGAR_SCREEN_TITLE = 'HANGAR WAR';

/** Bottom hint line advertising the shared keyboard controls. */
export const HANGAR_SCREEN_HINT =
  'tab/arrows move · enter/space select · ESC returns to the menu';

/**
 * A hangar row's state — the economy's verdict, presented.
 *
 * The first four are the purchase branch's verdicts (`canBuy`), unchanged. The
 * last three are the **owned-row upgrade affordance** (parent
 * AH-0MWHW4ALS0039JFU AC3): an owned level-bearing kind shows its current
 * permanent level and the price of the next one, and the same three-way
 * disabled vocabulary the purchase rows use — buyable (`upgradable`),
 * cannot-afford-it (`upgrade-unaffordable`) and no-further-level (`capped`).
 */
export type HangarUnlockState =
  | 'owned'
  | 'gated'
  | 'unaffordable'
  | 'buyable'
  | 'upgradable'
  | 'upgrade-unaffordable'
  | 'capped';

/**
 * The `⟲ RESTART WAR` confirmation row: the player-facing restart control.
 *
 * Built by {@link buildHangarRestartRow} and presented as the last row on the
 * hangar screen — the second bottom-row slot, beneath DEPLOY and the HEX MAP
 * (AH-0MW8F7NH1002PQE3). The armed/idle label lives in this interface; the
 * scene owns the arming state and timer.
 */
export interface HangarRestartRow {
  /** Row key (`restart`). */
  key: 'restart';
  /** Full row text as rendered (`⟲ RESTART WAR` or `⚠ PRESS AGAIN TO CONFIRM`). */
  label: string;
  /** True only when the row can be activated (handler provided and idle or armed). */
  actionable: boolean;
}

/** Row key of the hangar's restart row. */
export const RESTART_ROW_KEY = 'restart';

/**
 * Two-step confirm timeout in milliseconds.
 *
 * After the first activation the row shows `⚠ PRESS AGAIN TO CONFIRM` and
 * auto-reverts to idle after this duration, so a stray Enter can never reset
 * the war (AH-0MW8F7NH1002PQE3).
 */
export const RESTART_CONFIRM_TIMEOUT_MS = 5000;

/** One row of the unlock tree. */
export interface HangarUnlockRow {
  /** Row key (`buy:<entryId>`), unique within the screen. */
  key: string;
  /** Catalogue entry id (also the id persisted in the hangar's owned sets). */
  id: string;
  /** What kind of unlock it is. */
  kind: HangarEntryKind;
  /** Display name from the catalogue. */
  name: string;
  /** Rendered price (`FREE` for the starting kit). */
  priceLabel: string;
  /** The economy's verdict for this entry right now. */
  state: HangarUnlockState;
  /**
   * Shown verb/state (`BUY`, `OWNED`, `RING 2`, `NEED 40 min`, `UPGRADE ·
   * 100 min`, `MAX`).
   */
  actionLabel: string;
  /** Full row text as rendered. */
  label: string;
  /** True only when the row can be activated right now (buy **or** upgrade). */
  actionable: boolean;
  /**
   * The kind's current permanent level, for an owned level-bearing row (the
   * upgrade affordance); `null` on every other row.
   */
  level: number | null;
  /** The shared permanent-level ceiling on an upgrade row; `null` elsewhere. */
  maxLevel: number | null;
  /**
   * The rendered price of the next permanent level (`100 min`), or `null` when
   * there is no next level to price (a `capped` row, or no upgrade at all).
   */
  upgradePriceLabel: string | null;
  /**
   * This weapon's display verdict against the target boss (`strong` when the
   * boss is weak against it, `weak` when the boss resists it); `null` on every
   * non-weapon row, which keeps its existing rendering (AH-0MWMT4QXF0095CBN).
   */
  matchup: BossMatchup | null;
}

/** One hull option in the deployment selector. */
export interface HangarHullOption {
  /** Row key (`hull:<hullId>`). */
  key: string;
  /** Hull id. */
  id: string;
  /** Display name from the catalogue. */
  name: string;
  /** Whether this hull is the equipped one. */
  equipped: boolean;
  /** Full row text as rendered. */
  label: string;
  /** True when selecting this hull would change the deployment. */
  actionable: boolean;
}

/** One starting-weapon option in the deployment selector. */
export interface HangarWeaponOption {
  /** Row key (`weapon:<weaponId>`). */
  key: string;
  /** Weapon id (the catalogue entry id). */
  id: string;
  /** Display name from the catalogue. */
  name: string;
  /** Whether this weapon is in the active loadout. */
  equipped: boolean;
  /** Full row text as rendered. */
  label: string;
  /** True when toggling this weapon would change the loadout. */
  actionable: boolean;
  /**
   * This weapon's display verdict against the target boss (AH-0MWMT4QXF0095CBN):
   * `strong` when the boss's `weaknesses` name it, `weak` when its
   * `strengths` do, otherwise `neutral`.
   */
  matchup: BossMatchup;
  /**
   * The shared matchup glyph for this weapon against the selected hex
   * (AH-0MWL8965R008K588): the **same** vocabulary entry the fight draws, so
   * the selector and combat cannot drift. Resolved by the one matchup rule
   * (`resolveHexMatchup` over the hex's authored lookup), never re-derived.
   */
  matchupGlyph: MatchupGlyph;
}

/** One permanent-modifier option in the deployment selector. */
export interface HangarModifierOption {
  /** Row key (`modifier:<modifierId>`). */
  key: string;
  /** Modifier id (the catalogue entry id). */
  id: string;
  /** Display name from the catalogue. */
  name: string;
  /** Whether this modifier is applied to the active loadout. */
  equipped: boolean;
  /** Full row text as rendered. */
  label: string;
  /** True when toggling this modifier would change the deployment. */
  actionable: boolean;
}

/**
 * One installed power-up option in the deployment selector.
 *
 * A power-up is a permanent passive kind, not a flown slot, so its row reports
 * three facts rather than a boolean `equipped`:
 *
 * - `selected` — the kind is in the player's selection
 *   (`activeLoadout.powerUps`, or the all-owned default when absent);
 * - `equipped` — the kind is **actually installed**: it is selected *and* it
 *   survives the shared six-slot trim, which is exactly the set the run
 *   grants;
 * - `blocked` — selected but trimmed away by the cap, rendered as a
 *   non-actionable row so the display never silently differs from the grant
 *   (assumption A3).
 */
export interface HangarPowerUpOption {
  /** Row key (`power-up:<powerUpId>`). */
  key: string;
  /** Power-up id (the catalogue entry id). */
  id: string;
  /** Display name from the catalogue. */
  name: string;
  /** The permanent level the deployment grants (base `1` when unupgraded). */
  level: number;
  /** Whether the kind is in the player's selection. */
  selected: boolean;
  /** Whether the deployment actually installs the kind (selected and admitted). */
  equipped: boolean;
  /** Selected but trimmed away by the shared six-slot cap (non-actionable). */
  blocked: boolean;
  /** Full row text as rendered. */
  label: string;
  /** True when toggling this power-up would change the deployed build. */
  actionable: boolean;
}

/**
 * The primary deployment action row, built from the pure deployment payload
 * (AH-0MVUXC2DD003HN0I). It is always actionable: a fleet can always deploy,
 * even with the minimal starting kit and an empty ring.
 */
export interface HangarDeployRow {
  /** Row key (`deploy`). */
  key: 'deploy';
  /** The hex this deployment attacks, or `null` while the ring is empty. */
  hexId: string | null;
  /** The target hex's aggression (the difficulty input). */
  aggression: number;
  /** The campaign level the aggression selected. */
  startLevel: number;
  /** Full row text as rendered. */
  label: string;
  /** Always true: a deployment can always be launched. */
  actionable: boolean;
}

/**
 * The `⌗ HEX MAP` navigation row: the one click from what the player owns to
 * what the player holds.
 *
 * `HexMapScene` has carried the mirror-image `◀ HANGAR` row since
 * AH-0MVUXCAG90086LH2, but the hangar had no way back — a player entering the
 * Hangar War from the menu could only launch a blind deployment at the weakest
 * hex and never saw the ring intel the map exists to show. The design of
 * record is "the map and hangar one click apart" (GDD §8.2), so this row makes
 * that true in both directions.
 */
export interface HangarMapRow {
  /** Row key (`map`). */
  key: 'map';
  /** Full row text as rendered. */
  label: string;
  /** Always true: the map is always reachable. */
  actionable: boolean;
}

/** Row key of the hangar's navigation row to the hex map. */
export const HANGAR_MAP_ROW_KEY = 'map';

/**
 * Builds the `⌗ HEX MAP` navigation row (pure).
 *
 * The map is always reachable — it is a navigation action, not an economy one,
 * so it never depends on salvage, ring progress or ownership.
 */
export function buildHangarMapRow(): HangarMapRow {
  return {
    key: HANGAR_MAP_ROW_KEY,
    label: '⌗ HEX MAP — open the ring',
    actionable: true,
  };
}

/**
 * Builds the `⟲ RESTART WAR` reset row (pure).
 *
 * The row is always actionable: resetting is a navigation/state action, not
 * an economy one, so it never depends on salvage, ring progress or ownership.
 * The label flips to the confirm prompt once the scene arms the row. The
 * caller (`HangarScene`) owns the arming state and its timer.
 *
 * @param armed — whether the row is currently in its confirm step.
 * @returns the restart row.
 */
export function buildHangarRestartRow(armed = false): HangarRestartRow {
  return {
    key: RESTART_ROW_KEY,
    label: armed
      ? '⚠ PRESS AGAIN TO CONFIRM'
      : '⟲ RESTART WAR — start a fresh war',
    actionable: true,
  };
}

/**
 * Row key of the `⚡ APPLY SUGGESTED BUILDOUT` row — the one explicit action
 * that equips the boss-aware suggestion (parent AH-0MWOROJYT004WPSD).
 *
 * Exported as a stable key so the game, the gym and the tests can address the
 * row without spelling a string literal, exactly as the map/restart rows do.
 */
export const BUILDOUT_ROW_KEY = 'buildout';

/**
 * The `⚡ APPLY SUGGESTED BUILDOUT` row: the player-facing action that equips
 * the selector's suggestion (`suggestedLoadout`) on demand.
 *
 * The row is actionable whenever a suggestion exists — which is always, since
 * the selector is total — so a hand-picked loadout can be replaced only by a
 * deliberate activation, never silently by opening the screen
 * (producer Q1 = B). It sits in the fixed bottom-row block, directly above the
 * deployment it feeds.
 */
export interface HangarBuildoutRow {
  /** Stable row key ({@link BUILDOUT_ROW_KEY}). */
  key: string;
  /** Full row text as rendered (`⚡ APPLY SUGGESTED BUILDOUT — 3 weapons`). */
  label: string;
  /** True whenever a suggestion exists (always, for a total selector). */
  actionable: boolean;
}

/**
 * Builds the apply-suggested-buildout row (pure).
 *
 * The label states **what** it will equip (the suggested weapon count) and is
 * paired with a non-colour glyph (`⚡`), so the affordance is readable without
 * colour (repo CVD policy). The count comes from the one selector result the
 * model publishes, so the row and the applied buildout can never disagree.
 *
 * @param suggestion — the selector's published suggestion.
 * @returns the row the screen renders and focuses.
 */
export function buildHangarBuildoutRow(
  suggestion: AutoLoadoutSuggestion,
): HangarBuildoutRow {
  const count = suggestion.startingWeapons.length;
  return {
    key: BUILDOUT_ROW_KEY,
    label: `⚡ APPLY SUGGESTED BUILDOUT — ${count} weapon${count === 1 ? '' : 's'}`,
    actionable: true,
  };
}

/**
 * Whether the loadout is at its shipped default — an **empty** starting-weapon
 * selection (AH-0MWOWEF3Q008BO5J, producer Q1 = B).
 *
 * The rule is deliberately the raw persisted list, not `resolveActiveLoadout`
 * and not "the selector found no strong weapon": a hand-picked loadout whose
 * weapons are all neutral (or even resisted) is still a deliberate choice and
 * must never be auto-fitted. A modifier alone does not make a loadout
 * non-default — only starting weapons count.
 *
 * @param payload — the payload whose active loadout is inspected.
 * @returns true only when `activeLoadout.startingWeapons` is empty.
 */
export function isDefaultHangarLoadout(payload: HangarWarPayload): boolean {
  return payload.hangar.activeLoadout.startingWeapons.length === 0;
}

/** Row key of the hangar's `SAVE CURRENT BUILD` row. */
export const SAVE_BUILD_ROW_KEY = 'save-build';

/** Row key of the saved-build selector (cycles the selected build). */
export const CYCLE_BUILD_ROW_KEY = 'build:cycle';

/** The row-key builder for the selected build's verb row. */
export function savedBuildRowKey(verb: 'apply' | 'rename' | 'delete'): string {
  return `build:${verb}`;
}

/**
 * Builds the compact saved-build surface rows (pure, AH-0MWL8C6FE008G1E7).
 *
 * A **fixed** five rows regardless of how many builds exist, so an unbounded
 * list never overflows the shipped screen and every entry stays reachable:
 *
 * - `save` — capture the currently equipped ship as a new saved build;
 * - `cycle` — advance the selected index through the list (the drop-down);
 * - `apply` — purchase and equip the selected build in one action;
 * - `rename` — rename the selected build;
 * - `delete` — delete the selected build.
 *
 * With no saved builds only the `save` row is actionable; the other four are
 * rendered disabled so the affordance is discoverable. Because the selected
 * index can be advanced to **any** entry, deleting is reachable for every
 * saved build (AC5) without a per-build row.
 *
 * @param payload — the current payload (the hangar carries the saved builds).
 * @param selectedIndex — the index of the currently selected build (clamped).
 * @returns the rows in reading order (save, cycle, apply, rename, delete).
 */
export function buildHangarSavedBuildRows(
  payload: HangarWarPayload,
  selectedIndex = 0,
): HangarSavedBuildRow[] {
  const builds = payload.hangar.savedBuilds ?? [];
  const hasBuilds = builds.length > 0;
  const index = hasBuilds
    ? Math.min(Math.max(0, Math.trunc(selectedIndex)), builds.length - 1)
    : 0;
  const selected = hasBuilds ? builds[index] : null;
  const position = hasBuilds ? index + 1 : 0;
  const name = selected?.name ?? null;

  const saveRow: HangarSavedBuildRow = {
    key: SAVE_BUILD_ROW_KEY,
    verb: 'save',
    buildId: null,
    name: 'SAVE CURRENT BUILD',
    label: '＋ SAVE CURRENT BUILD',
    actionable: true,
  };

  // With no saved builds only the save row is shown, so a fresh hangar keeps
  // its compact layout (and the always-present save affordance is discoverable).
  if (!hasBuilds) return [saveRow];

  return [
    saveRow,
    {
      key: CYCLE_BUILD_ROW_KEY,
      verb: 'cycle',
      buildId: selected?.id ?? null,
      name: name ?? 'SAVED BUILDS: none',
      label: `◀ ▶ SAVED BUILD ${position}/${builds.length} — “${name}”`,
      actionable: builds.length > 1,
    },
    {
      key: savedBuildRowKey('apply'),
      verb: 'apply',
      buildId: selected?.id ?? null,
      name: name ?? '',
      label: `▶ FLY “${name}” — re-buy & equip`,
      actionable: true,
    },
    {
      key: savedBuildRowKey('rename'),
      verb: 'rename',
      buildId: selected?.id ?? null,
      name: name ?? '',
      label: `✎ RENAME “${name}”`,
      actionable: true,
    },
    {
      key: savedBuildRowKey('delete'),
      verb: 'delete',
      buildId: selected?.id ?? null,
      name: name ?? '',
      label: `✖ DELETE “${name}”`,
      actionable: true,
    },
  ];
}

/**
 * The target hex's authored boss intel, as the config screen publishes it
 * (AH-0MWMT4QXF0095CBN).
 *
 * Read from the shared authored ring definitions, never a scene-local copy.
 * Total: an empty ring (no target) or a stored hex with no authored definition
 * publishes `known: false` and an explicit unknown fallback rather than
 * throwing.
 */
export interface HangarBossIntel {
  /** The resolved target hex (the hex `▶ DEPLOY` launches at), or `null`. */
  readonly hexId: string | null;
  /** The boss that holds the target hex, or `null` when it is not authored. */
  readonly boss: string | null;
  /** What that boss is strong against (empty when unknown). */
  readonly strengths: readonly string[];
  /** What that boss is weak against (empty when unknown). */
  readonly weaknesses: readonly string[];
  /** Whether an authored definition was found for the target hex. */
  readonly known: boolean;
}

/** The non-colour tag a strong (countering) weapon row carries. */
export const HANGAR_STRONG_MARKER = MATCHUP_GLYPHS.effective.marker;

/** The non-colour tag a weak (resisted) weapon row carries. */
export const HANGAR_WEAK_MARKER = MATCHUP_GLYPHS.resisted.marker;

/** The non-colour tag a neutral weapon row carries (never a blank mark). */
export const HANGAR_NEUTRAL_MARKER = MATCHUP_GLYPHS.neutral.marker;

/**
 * The visible mutation on a matchup-tagged label.
 *
 * Every state is marked on the **loadout selector** — neutral included:
 * "unmarked" would be indistinguishable from "no data" for a player reading
 * without colour (AH-0MWL8965R008K588). The markers are the shared
 * vocabulary's, so the selector cannot drift from the combat feedback.
 *
 * `markNeutral` is off for the unlock-tree rows, which keep their historical
 * rendering for a neutral entry (their own byte-identical contract, AC3 of
 * AH-0MWI5AK1E008HDHH) — the glyph vocabulary they draw is still the shared
 * one.
 */
function withMatchupMarker(
  label: string,
  matchup: BossMatchup | null,
  markNeutral = false,
): string {
  if (matchup === 'strong') return `${label} — ${HANGAR_STRONG_MARKER}`;
  if (matchup === 'weak') return `${label} — ${HANGAR_WEAK_MARKER}`;
  if (matchup === 'neutral' && markNeutral) {
    return `${label} — ${HANGAR_NEUTRAL_MARKER}`;
  }
  return label;
}

/** The complete rendered state of the hangar screen (pure data). */
/**
 * One row of the saved-build surface (AH-0MWL8C6FE008G1E7).
 *
 * `save` captures the currently equipped ship; `apply` re-purchases and
 * re-equips a saved build in one action; `rename` and `delete` manage an
 * existing entry. The `key` is unique within the screen (`build:<id>:<verb>` or
 * `save-build`) so the shared `FocusManager` can address each row.
 */
export interface HangarSavedBuildRow {
  /** Unique row key (`save-build`, `build:saved:<verb>`). */
  key: string;
  /** What activating the row does. */
  verb: 'save' | 'cycle' | 'apply' | 'rename' | 'delete';
  /** The currently selected saved build's id (`null` when none selected). */
  buildId: string | null;
  /** The selected build's display name (or a fixed label). */
  name: string;
  /** Full row text as rendered. */
  label: string;
  /** Whether the row can be activated right now. */
  actionable: boolean;
}

export interface HangarScreenModel {
  /** Screen title. */
  title: string;
  /** Banked salvage line. */
  salvageLine: string;
  /** Ring progress line. */
  ringLine: string;
  /** Unlock-tree rows, in catalogue order. */
  unlockRows: HangarUnlockRow[];
  /** Hull selector rows, in owned order. */
  hullOptions: HangarHullOption[];
  /** Starting-weapon selector rows, in owned order. */
  weaponOptions: HangarWeaponOption[];
  /** Permanent-modifier selector rows, in owned order. */
  modifierOptions: HangarModifierOption[];
  /**
   * Installed level-bearing power-up selector rows, in owned order (the
   * weapon/modifier-style toggle list for the permanent power-up kinds).
   */
  powerUpOptions: HangarPowerUpOption[];
  /** The ▶ DEPLOY row (the deployment this loadout launches). */
  deployRow: HangarDeployRow;
  /**
   * The boss-aware selector's suggestion for this payload and target
   * (AH-0MWOWEF3Q008BO5J) — a full replacement derived from ownership, levels
   * and the target, never from the current loadout. Published separately from
   * the equipped rows, so a hand-picked loadout is shown unchanged beside the
   * suggestion until the player explicitly applies it.
   */
  suggestedLoadout: AutoLoadoutSuggestion;
  /** The `⚡ APPLY SUGGESTED BUILDOUT` row (the explicit apply action). */
  buildoutRow: HangarBuildoutRow;
  /** The `⌗ HEX MAP` navigation row (one click to what the player holds). */
  mapRow: HangarMapRow;
  /** The `⟲ RESTART WAR` reset row (two-step confirm, `bestScore` kept). */
  restartRow: HangarRestartRow;
  /**
   * A transient saved-build message (an apply refusal's shortfall, or a save
   * confirmation), rendered above the restart row. `null` when there is none.
   */
  savedBuildMessage: string | null;
  /**
   * The saved-build rows — the drop-down list plus the save/rename/delete
   * affordances (AH-0MWL8C6FE008G1E7). One `save` row first, then an `apply`,
   * `rename` and `delete` row for every saved build, so deletion is reachable
   * for every entry.
   */
  savedBuildRows: HangarSavedBuildRow[];
  /**
   * The target hex's authored boss intel (AH-0MWMT4QXF0095CBN): the resolved
   * target, its boss name and authored strengths/weaknesses lists, or an
   * explicit unknown fallback for an unauthored/unknown hex.
   */
  bossIntel: HangarBossIntel;
  /**
   * Keys of the rows that can be activated, in reading order — exactly the
   * rows registered with the shared `FocusManager` (disabled rows are never
   * focusable, so keyboard navigation cannot reach them).
   */
  focusOrder: string[];
}

/** The attract bot's next hangar action (pure, never stalls). */
export type HangarAttractDecision =
  | { readonly kind: 'buy'; readonly entryId: string }
  | {
      readonly kind: 'deploy';
      readonly hullId: string;
      readonly loadout: HangarLoadout;
    };

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** A detached copy of a payload, so no update can mutate its caller's state. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return {
    ...payload,
    hangar: {
      ...payload.hangar,
      unlockedHulls: [...payload.hangar.unlockedHulls],
      unlockedWeapons: [...payload.hangar.unlockedWeapons],
      ownedModifiers: [...payload.hangar.ownedModifiers],
      activeLoadout: {
        startingWeapons: [...payload.hangar.activeLoadout.startingWeapons],
        modifiers: [...payload.hangar.activeLoadout.modifiers],
        // Preserve the tri-state so an update can never materialise an absent
        // selection or discard an explicit one.
        ...(payload.hangar.activeLoadout.powerUps !== undefined
          ? { powerUps: [...payload.hangar.activeLoadout.powerUps] }
          : {}),
      },
      ...(payload.hangar.savedBuilds !== undefined
        ? {
            savedBuilds: payload.hangar.savedBuilds.map((build) => ({
              ...build,
              startingWeapons: [...build.startingWeapons],
              modifiers: [...build.modifiers],
              weaponLevels: build.weaponLevels?.map((row) => ({ ...row })),
              powerUpLevels: build.powerUpLevels?.map((row) => ({ ...row })),
            })),
          }
        : {}),
    },
    ring: { ...payload.ring, hexes: payload.ring.hexes.map((hex) => ({ ...hex })) },
    pendingAttacks: payload.pendingAttacks.map((attack) => ({ ...attack })),
  };
}

/**
 * A two-currency price as rendered (`100 min`, `150 min · 1 cores`).
 *
 * Single-homed so the purchase rows and the owned-row upgrade affordance
 * spell a price the same way: only the currency pair is ever shown, never a
 * currency the price does not spend.
 */
function formatHangarPrice(price: HangarPrice): string {
  const minerals = toCount(price.minerals);
  const cores = toCount(price.cores);
  return cores > 0 ? `${minerals} min · ${cores} cores` : `${minerals} min`;
}

/** The price of an entry as rendered (`FREE` for the starting kit). */
function formatPrice(entry: HangarEntry): string {
  if (entry.starter) return 'FREE';
  return formatHangarPrice(entry.price);
}

/**
 * What the fleet is missing, as rendered (`90 min / 2 cores`).
 *
 * The one spelling of a shortfall, shared by the purchase rows
 * (`NEED 90 min / 2 cores`) and the upgrade rows (`UPGRADE · 150 min — NEED
 * 150 min`), so a disabled row always reads the same way.
 */
function formatShortfall(shortfall: { minerals: number; cores: number }): string {
  const minerals = toCount(shortfall.minerals);
  const cores = toCount(shortfall.cores);
  const parts: string[] = [];
  if (minerals > 0) parts.push(`${minerals} min`);
  if (cores > 0) parts.push(`${cores} cores`);
  return parts.join(' / ');
}

/** The state verb/needed-salvage text for an unlock row. */
function actionLabelFor(
  entry: HangarEntry,
  state: HangarUnlockState,
  shortfall: { minerals: number; cores: number },
): string {
  switch (state) {
    case 'owned':
      return 'OWNED';
    case 'gated':
      return `RING ${toCount(entry.minRing)}`;
    case 'unaffordable':
      return `NEED ${formatShortfall(shortfall)}`;
    case 'buyable':
      return 'BUY';
    case 'upgradable':
      return 'UPGRADE';
    case 'upgrade-unaffordable':
      return 'UPGRADE';
    case 'capped':
      return 'MAX';
  }
}

/**
 * The owned-row upgrade affordance for one catalogue entry, or `null` when the
 * entry has no permanent level to raise (so its row stays exactly as before).
 *
 * The purchase branch (`canBuy`) only ever says *owned* about a kind the fleet
 * has, so this branch answers the next question: **is there a further level to
 * sell?** It asks the one pure economy rule (`costToUpgrade`) — no price, cap
 * or ownership decision is re-derived here — and returns `null` for the two
 * refusal classes that mean "this kind is not upgradeable at all":
 *
 * - `unknown` — a hull or modifier id (no permanent level), and
 * - `non-upgradeable` — a consumable or field-pickup-only power-up (producer
 *   Q2 = (a): a charge pool or a pickup rule has no level to raise).
 *
 * Those rows keep today's `OWNED` rendering byte-for-byte (AC3), and so does an
 * `unowned` refusal (unreachable from an *owned* purchase verdict, but a
 * refusal the screen must never dress up as an upgrade).
 *
 * The level shown is the run's own permanent level: the economy reads a kind
 * with no bought row as the base level `1` (AH-0MWI5AG1X0007XZH,
 * off-by-one fix AH-0MWKV6F26008X1T3), so the row never shows `LV 0` for a
 * weapon the fleet flies and advances on the first affordable purchase. The
 * renderer is kind-agnostic on purpose: an owned power-up level row renders
 * through exactly this path too (a purchase seeds its level-1 row —
 * AH-0MWKT12BT001106T), so no kind-specific affordance code exists.
 */
function buildUpgradeAffordance(
  payload: HangarWarPayload,
  entry: HangarEntry,
): Partial<HangarUnlockRow> | null {
  const levels = hangarPermanentLevels(payload.hangar);
  const check = costToUpgrade(payload.hangar, entry.id, levels, {
    ringIndex: payload.ring.ringIndex,
  });
  const refusal: UpgradeRefusal | null = check.reason;
  if (
    refusal === 'unknown'
    || refusal === 'non-upgradeable'
    || refusal === 'unowned'
  ) {
    return null;
  }

  // The economy's one pricing-basis reader floors the level at the base the
  // run already flies, so the row shows the level the next step raises from.
  const level = currentUpgradeLevel(levels, entry.id);
  const state: HangarUnlockState =
    refusal === 'capped'
      ? 'capped'
      : refusal === null
        ? 'upgradable'
        : 'upgrade-unaffordable';
  const priceLabel = state === 'capped' ? null : formatHangarPrice(check.price);
  const actionLabel =
    state === 'capped'
      ? 'MAX'
      : state === 'upgradable'
        ? `UPGRADE · ${priceLabel}`
        : `UPGRADE · ${priceLabel} — NEED ${formatShortfall(check.shortfall)}`;
  return {
    state,
    actionable: state === 'upgradable',
    level,
    maxLevel: MAX_PERMANENT_LEVEL,
    upgradePriceLabel: priceLabel,
    actionLabel,
    label: `${entry.name} — LV ${level}/${MAX_PERMANENT_LEVEL} — ${actionLabel}`,
  };
}

/**
 * Builds the unlock-tree rows for a hangar at a given ring.
 *
 * Every **purchasable** catalogue entry is presented, including the starter
 * kit, so the tree reads as a tree ("what I own and what is next"); the
 * economy decides each row's state with `owned` → `gated` → `unaffordable`
 * precedence. A **grant-only** entry (a special-mission reward, see
 * `isPurchasableEntry`) is not for sale, so it appears only once the fleet has
 * been granted it — where it reads as `OWNED` like any other reward.
 *
 * An **owned level-bearing kind** (a weapon or a power-up) is not a dead
 * `OWNED` row: it shows its current permanent level and the priced upgrade
 * action, decided by the pure {@link buildUpgradeAffordance} branch over the
 * economy's `costToUpgrade`. Every non-upgradeable row — a consumable, a
 * field-pickup-only kind, a hull, a modifier, and any row the fleet does not
 * own (gated/unaffordable) — renders byte-identically to before.
 *
 * @param payload — the payload whose hangar and ring are shown.
 * @param catalogue — the tree to present (injectable for tests/fixtures).
 * @param target — the target boss's authored lists, or `null` for no target
 *   (every weapon row then resolves `neutral`).
 * @returns the unlock rows, in catalogue order.
 */
export function buildHangarUnlockRows(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  target: MatchupDefinition | null = null,
): HangarUnlockRow[] {
  const context = { ringIndex: payload.ring.ringIndex };
  return catalogue
    .filter(
      (entry) => isPurchasableEntry(entry) || ownsEntry(payload.hangar, entry),
    )
    .map((entry) => {
      const check = canBuy(payload.hangar, entry, context);
      const state: HangarUnlockState = check.ok
        ? 'buyable'
        : (check.reason ?? 'owned');
      const upgrade =
        state === 'owned' ? buildUpgradeAffordance(payload, entry) : null;
      const actionLabel = upgrade?.actionLabel
        ?? actionLabelFor(entry, state, check.shortfall);
      // Only a weapon row can be strong or weak against the boss; every other
      // kind keeps its existing rendering byte-for-byte (parent assumption A3).
      const matchup = entry.kind === 'weapon'
        ? resolveBossMatchup(entry.weaponId, target)
        : null;
      return {
        key: `buy:${entry.id}`,
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
        priceLabel: formatPrice(entry),
        state: upgrade?.state ?? state,
        actionLabel,
        label: withMatchupMarker(
          upgrade?.label
            ?? `${entry.name} — ${formatPrice(entry)} — ${actionLabel}`,
          matchup,
        ),
        actionable: upgrade !== null ? upgrade.actionable === true : state === 'buyable',
        level: upgrade?.level ?? null,
        maxLevel: upgrade?.maxLevel ?? null,
        upgradePriceLabel: upgrade?.upgradePriceLabel ?? null,
        matchup,
      };
    });
}

/** The hull options for the deployment selector (owned hulls only). */
export function buildHangarHullOptions(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarHullOption[] {
  const activeHull = resolveActiveHull(payload.hangar);
  const options: HangarHullOption[] = [];
  for (const id of payload.hangar.unlockedHulls) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== 'hull') continue;
    const equipped = id === activeHull;
    options.push({
      key: `hull:${id}`,
      id,
      name: entry.name,
      equipped,
      label: `HULL ${entry.name}${equipped ? ' — EQUIPPED' : ''}`,
      actionable: !equipped,
    });
  }
  return options;
}

/** The starting-weapon options for the deployment selector (owned only). */
export function buildHangarWeaponOptions(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  target: MatchupDefinition | null = null,
): HangarWeaponOption[] {
  const loadout = resolveActiveLoadout(payload.hangar);
  const equippedIds = new Set(loadout.startingWeapons);
  // The verdict comes from the **one** matchup rule over the hex's authored
  // lookup — the selector never re-derives it (AH-0MWL8965R008K588).
  const lookup = target
    ? buildAuthoredVerdictLookup(target.strengths, target.weaknesses)
    : null;
  const options: HangarWeaponOption[] = [];
  for (const id of payload.hangar.unlockedWeapons) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== 'weapon') continue;
    const equipped = equippedIds.has(id);
    // Resolved from the shipped weapon id through the F1 rule, so the
    // ring-data (`waveLaser`) and catalogue (`wave_laser`) spellings agree.
    const verdict = resolveHexMatchup(entry.weaponId, lookup);
    const matchup: BossMatchup =
      verdict === 'effective'
        ? 'strong'
        : verdict === 'resisted'
          ? 'weak'
          : 'neutral';
    options.push({
      key: `weapon:${id}`,
      id,
      name: entry.name,
      equipped,
      label: withMatchupMarker(
        `LOADOUT ${entry.name}${equipped ? ' — EQUIPPED' : ''}`,
        matchup,
        true,
      ),
      // Every owned weapon is toggleable, including the last equipped one:
      // the player may deploy with no extra weapon at all, in which case the
      // run starts with only the ship's permanent cannon
      // (AH-0MVZJ6V1J001DA9D).
      actionable: true,
      matchup,
      matchupGlyph: matchupGlyphFor(verdict),
    });
  }
  return options;
}

/** The permanent-modifier options for the deployment selector (owned only). */
export function buildHangarModifierOptions(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarModifierOption[] {
  const equippedIds = new Set(
    resolveActiveLoadout(payload.hangar).modifiers,
  );
  const options: HangarModifierOption[] = [];
  for (const id of payload.hangar.ownedModifiers) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== 'modifier') continue;
    const equipped = equippedIds.has(id);
    options.push({
      key: `modifier:${id}`,
      id,
      name: entry.name,
      equipped,
      label: `MODIFIER ${entry.name}${equipped ? ' — ON' : ' — OFF'}`,
      actionable: true,
    });
  }
  return options;
}

/**
 * Builds the power-up rows for the deployment selector (owned, level-bearing
 * kinds only), marking each as installed, off or blocked by the shared cap.
 *
 * The displayed loadout must equal the granted one (assumption A3), so the
 * installed/blocked split is read from **the same** deployment the run builds:
 * `deployment.powerUpLevels` is the resolved selection and
 * {@link admittedDeploymentDropIds} is the one six-slot trim the grant applies.
 * An unselected kind that would not be admitted anyway is rendered
 * non-actionable, so the player is never offered a toggle that changes
 * nothing in the run.
 *
 * @param payload — the payload to present (never mutated).
 * @param catalogue — the tree to resolve against (injectable for tests).
 * @param deployment — the resolved deployment (built once by the model);
 *   defaults to building it from `payload` so the function is total.
 * @returns the power-up selector rows, in install order.
 */
export function buildHangarPowerUpOptions(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  deployment?: HangarWarDeployment,
): HangarPowerUpOption[] {
  const owned = ownedLevelBearingPowerUpLevels(payload.hangar);
  const selected = new Set(
    resolveActiveLoadout(payload.hangar, catalogue).powerUps ?? [],
  );
  const resolved = deployment
    ?? buildHangarDeployment(payload, { catalogue });
  const admitted = new Set(admittedDeploymentDropIds(resolved));
  const currentIds = [
    ...resolved.startingWeapons,
    ...resolved.powerUpLevels.map((row) => row.id),
  ];

  return owned.map((row) => {
    const entry = findHangarEntry(row.id, catalogue);
    // The hangar catalogue supplies the nicer display name for a sold kind; a
    // hex-granted power-up falls back to its shipped catalogue name.
    const name =
      entry?.name
      ?? POWER_UP_CATALOGUE[row.id]?.name
      ?? row.id;
    const isSelected = selected.has(row.id);
    const equipped = admitted.has(row.id);
    const blocked = isSelected && !equipped;
    // An unselected kind is selectable only when adding it would actually be
    // admitted; otherwise the toggle would change nothing in the run.
    const addable = blocked
      ? false
      : equipped || currentIds.includes(row.id)
        || admittedSetWith(currentIds, row.id).has(row.id);
    const actionable = blocked ? false : addable;
    const marker = blocked
      ? ' — BLOCKED (SLOTS FULL)'
      : equipped
        ? ' — EQUIPPED'
        : ' — OFF';
    return {
      key: `power-up:${row.id}`,
      id: row.id,
      name,
      level: row.level,
      selected: isSelected,
      equipped,
      blocked,
      label: `POWER-UP ${name}${marker}`,
      actionable,
    };
  });
}

/** The admitted set when `id` is appended to `ids` (one shared cap rule). */
function admittedSetWith(ids: readonly string[], id: string): Set<string> {
  return new Set(capDropIdsToSlotPool([...ids, id]));
}
export interface BuildHangarDeployRowOptions {
  /**
   * The hex the player chose on the map. Omitted/`null` keeps the existing
   * default (the weakest unheld hex, via `selectDeploymentHex`).
   */
  readonly targetHexId?: string | null;
}

/**
 * Builds the ▶ DEPLOY row from the pure deployment payload (pure).
 *
 * The label states the target and the difficulty it selects — the same
 * `startLevel` the run will actually begin at — so the player can read the
 * hex-aggression difficulty before committing to the deployment. An explicit
 * `targetHexId` is threaded into the **same** {@link buildHangarDeployment}
 * call that launches the run, so the row and the launch can never disagree.
 */
export function buildHangarDeployRow(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  options: BuildHangarDeployRowOptions = {},
): HangarDeployRow {
  const deployment: HangarWarDeployment = buildHangarDeployment(payload, {
    catalogue,
    hexId: options.targetHexId ?? null,
  });
  const target = deployment.hexId === null ? 'no hex' : `hex ${deployment.hexId}`;
  return {
    key: 'deploy',
    hexId: deployment.hexId,
    aggression: deployment.aggression,
    startLevel: deployment.startLevel,
    label:
      `▶ DEPLOY — ${target} · aggression ${deployment.aggression}`
      + ` · level ${deployment.startLevel}`,
    actionable: true,
  };
}

/**
 * Resolves the authored boss intel for a target hex (pure and total).
 *
 * The definition comes from the shared authored ring data (or an injected
 * {@link HangarScreenModelOptions.definitions} override), never a scene-local
 * copy. A `null` target (an empty ring) or an unauthored/unknown hex publishes
 * `known: false` with the explicit unknown fallback rather than throwing.
 *
 * @param hexId — the resolved target hex id, or `null`.
 * @param definitions — the authored definitions to read (defaults to shipped).
 * @returns the boss intel the screen publishes.
 */
export function buildHangarBossIntel(
  hexId: string | null,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
): HangarBossIntel {
  const definition = hexId === null
    ? undefined
    : definitions.find((entry) => entry.id === hexId);
  return {
    hexId,
    boss: definition?.boss ?? null,
    strengths: definition ? [...definition.strengths] : [],
    weaknesses: definition ? [...definition.weaknesses] : [],
    known: definition !== undefined,
  };
}

/** The ring progress line (`Ring 1 — 2/6 hexes held`). */
export function formatRingLine(ring: HexRingState): string {
  const held = ring.hexes.filter((hex) => hex.held).length;
  return `Ring ${ring.ringIndex} — ${held}/${ring.hexes.length} hexes held`;
}

/** The banked salvage line. */
export function formatSalvageLine(payload: HangarWarPayload): string {
  return `Salvage: ${toCount(payload.hangar.bankedMinerals)} minerals · ${toCount(
    payload.hangar.bankedCores,
  )} cores`;
}

/**
 * Builds the complete hangar-screen model (pure).
 *
 * Reading order is the focus order: the unlock tree first, then hulls, the
 * starting-weapon loadout (weapons then the installable `POWER-UP` rows), the
 * modifiers and the saved builds, then the
 * `⚡ APPLY SUGGESTED BUILDOUT` row, the deployment, the map and the restart
 * rows. Only actionable rows enter the focus order (the buildout row always
 * is).
 *
 * @param payload — the payload to present (never mutated).
 * @param catalogue — the tree to present (injectable for tests/fixtures).
 * @param options — target hex, authored definitions and restart state.
 * @returns the model rendered by the game and the gym.
 */
export function buildHangarScreenModel(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  options: HangarScreenModelOptions = {},
): HangarScreenModel {
  // One resolution for the whole screen: the deploy row resolves the target
  // through the shared deployment builder, and the intel/matchups read that
  // resolved hex — never a second `selectDeploymentHex` call that could
  // disagree with what `▶ DEPLOY` launches at (AH-0MWMT4QXF0095CBN).
  const deployRow = buildHangarDeployRow(payload, catalogue, {
    targetHexId: options.targetHexId ?? null,
  });
  const definitions = options.definitions ?? HEX_RING_DEFINITIONS;
  const target = deployRow.hexId === null
    ? null
    : definitions.find((entry) => entry.id === deployRow.hexId) ?? null;
  const bossIntel = buildHangarBossIntel(deployRow.hexId, definitions);
  const unlockRows = buildHangarUnlockRows(payload, catalogue, target);
  const hullOptions = buildHangarHullOptions(payload, catalogue);
  const weaponOptions = buildHangarWeaponOptions(payload, catalogue, target);
  // The deployment the ▶ DEPLOY row describes, resolved once so the power-up
  // rows' installed/blocked split is read from exactly the launch the run
  // builds (`buildHangarDeployRow` resolves the same pure payload).
  const deployment = buildHangarDeployment(payload, {
    catalogue,
    hexId: options.targetHexId ?? null,
  });
  const powerUpOptions = buildHangarPowerUpOptions(
    payload,
    catalogue,
    deployment,
  );
  // The suggestion is fitted against exactly the intel the screen publishes
  // (`bossIntel`), never a second target resolution, so the row's count and
  // the deployed loadout agree with the TARGET INTEL block above them.
  const suggestedLoadout = selectAutoLoadout(payload, bossIntel, catalogue);
  const buildoutRow = buildHangarBuildoutRow(suggestedLoadout);
  const modifierOptions = buildHangarModifierOptions(payload, catalogue);
  const mapRow = buildHangarMapRow();
  const restartRow = buildHangarRestartRow(options.restartArmed === true);
  const savedBuildRows = buildHangarSavedBuildRows(
    payload,
    options.savedBuildIndex ?? 0,
  );
  const focusOrder = [
    ...unlockRows.filter((row) => row.actionable),
    ...hullOptions.filter((row) => row.actionable),
    ...weaponOptions.filter((row) => row.actionable),
    ...powerUpOptions.filter((row) => row.actionable),
    ...modifierOptions.filter((row) => row.actionable),
    ...savedBuildRows.filter((row) => row.actionable),
    // The apply-suggested-buildout row sits with the loadout it replaces and
    // immediately before the deployment it feeds, so keyboard reach matches
    // the screen's reading order (AH-0MWOWEF3Q008BO5J).
    buildoutRow,
    deployRow,
    // The navigation row follows the primary action, mirroring `HexMapScene`'s
    // convention of placing its own navigation row last in the focus order.
    mapRow,
    // The restart row is the last row on screen — a destructive action sits
    // last so a stray Enter never reaches it by accident.
    restartRow,
  ].map((row) => row.key);
  return {
    title: HANGAR_SCREEN_TITLE,
    salvageLine: formatSalvageLine(payload),
    ringLine: formatRingLine(payload.ring),
    unlockRows,
    hullOptions,
    weaponOptions,
    powerUpOptions,
    modifierOptions,
    deployRow,
    suggestedLoadout,
    buildoutRow,
    mapRow,
    restartRow,
    savedBuildMessage: options.savedBuildMessage ?? null,
    savedBuildRows,
    bossIntel,
    focusOrder,
  };
}

/**
 * The attract bot's next hangar move (pure): buy the cheapest useful unlock,
 * or — when nothing is buyable — accept the active hull and loadout and
 * deploy. Never returns "wait", so the demo can never stall on this screen.
 *
 * @param payload — the current payload (never mutated).
 * @param catalogue — the tree to shop in (injectable for tests/fixtures).
 * @returns the decision.
 */
export function hangarAttractDecision(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarAttractDecision {
  const entry = cheapestUsefulUnlock(
    payload.hangar,
    { ringIndex: payload.ring.ringIndex },
    catalogue,
  );
  if (entry !== null) return { kind: 'buy', entryId: entry.id };
  return {
    kind: 'deploy',
    hullId: resolveActiveHull(payload.hangar),
    loadout: resolveActiveLoadout(payload.hangar),
  };
}

/** The result of a pure hangar update: a fresh payload, or a refusal. */
export interface HangarUpdateResult {
  /** Whether the update happened. */
  readonly ok: boolean;
  /** Why a purchase was refused (`null` when it happened / not a purchase). */
  readonly reason: 'owned' | 'gated' | 'unaffordable' | 'unknown' | null;
  /** The payload after the update (always fresh; the input is untouched). */
  readonly payload: HangarWarPayload;
}

/** The result of a pure upgrade update: a fresh payload, or a refusal. */
export interface HangarUpgradeUpdateResult {
  /** Whether the upgrade happened. */
  readonly ok: boolean;
  /** Why the upgrade was refused (`null` when it happened). */
  readonly reason: UpgradeRefusal | null;
  /** What was spent (the zero price on refusal). */
  readonly spent: HangarPrice;
  /** The payload after the upgrade (always fresh; the input is untouched). */
  readonly payload: HangarWarPayload;
}

/**
 * Buys one catalogue entry and returns the updated payload (pure).
 *
 * Delegates every rule to the economy's `buy`, opting in to
 * `equipOnPurchase` so a hangar-screen purchase lands owned **and** armed in
 * one payload (parent AH-0MWL5PAP2001XYYF, producer Q1 = C refined): a hull
 * becomes the active hull, a starting weapon joins the loadout and a modifier
 * is switched on. A refusal still changes neither ownership nor the loadout.
 * The caller persists the result through the hangar-war store, so the spend and
 * the auto-equip can never land separately.
 */
export function purchaseHangarEntry(
  payload: HangarWarPayload,
  entryId: string,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarUpdateResult {
  const entry = findHangarEntry(entryId, catalogue);
  if (entry === null) {
    return { ok: false, reason: 'unknown', payload: clonePayload(payload) };
  }
  const result = buy(
    payload.hangar,
    entry,
    { ringIndex: payload.ring.ringIndex },
    { equipOnPurchase: true },
  );
  const next = clonePayload(payload);
  next.hangar = result.hangar;
  return { ok: result.ok, reason: result.reason, payload: next };
}

/**
 * Buys the next permanent level of an owned level-bearing kind and returns the
 * updated payload (pure).
 *
 * Delegates every rule to the hangar-war store's `buyHangarUpgrade` (which
 * feeds the **one** pure economy rule, `buyUpgrade`, the fleet's persisted
 * levels and writes the raised snapshot back into the payload); this updater
 * only carries the war's ring context, exactly as {@link purchaseHangarEntry}
 * does for {@link buy}. The caller persists the result through
 * `hangarWarStore.saveHangarWarPayload`, so the spent currency and the raised
 * level can never land separately.
 *
 * A refusal (`unknown` / `non-upgradeable` / `unowned` / `capped` /
 * `unaffordable`) spends nothing and raises no level, so a stale UI can never
 * buy a level the economy did not authorise.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param kindId — the owned weapon/power-up id to upgrade.
 * @returns the upgrade outcome and the payload to persist.
 */
export function upgradeHangarKind(
  payload: HangarWarPayload,
  kindId: string,
): HangarUpgradeUpdateResult {
  const outcome = buyHangarUpgrade(payload, kindId, {
    ringIndex: payload.ring.ringIndex,
  });
  return {
    ok: outcome.ok,
    reason: outcome.reason,
    spent: outcome.spent,
    payload: outcome.payload,
  };
}

/**
 * Equips an owned hull and returns the updated payload (pure).
 * *
 * An unowned/unknown hull leaves the payload unchanged (the economy refuses
 * it), so a corrupt UI selection can never deploy an unowned ship.
 */
export function equipHangarHull(
  payload: HangarWarPayload,
  hullId: string,
): HangarUpdateResult {
  const next = clonePayload(payload);
  next.hangar = equipHull(payload.hangar, hullId);
  return { ok: next.hangar.activeHull === hullId, reason: null, payload: next };
}

/** The result of applying the boss-aware suggestion: a fresh payload.
 *
 * `changed` is what the scene branches on: an already-suggested loadout needs
 * no further `saveHangarWarPayload` write, so re-applying cannot churn the
 * persisted payload.
 */
export interface HangarBuildoutApplyResult {
  /** Whether the loadout actually changed (false when it already matched). */
  readonly changed: boolean;
  /** The selector result that was applied (the model publishes the same one). */
  readonly suggestion: AutoLoadoutSuggestion;
  /** The payload after the update (always fresh; the input is untouched). */
  readonly payload: HangarWarPayload;
}

/**
 * Equips the boss-aware suggestion as a full replacement loadout (pure).
 *
 * The one updater behind the `⚡ APPLY SUGGESTED BUILDOUT` row: it asks the
 * shared selector for its result, then writes it through the economy's
 * `equipLoadout` path — no selection, matchup or ownership rule is re-derived
 * here, and the equipped list is filtered to owned entries by the economy
 * exactly as every manual toggle is. Modifiers are carried across untouched
 * (the suggestion only ever selects starting weapons). The suggestion's
 * **granted power-ups** become the explicit `activeLoadout.powerUps`
 * selection, so the auto-loadout selector can install power-ups through the
 * same tri-state field a manual toggle writes.
 *
 * The selector ignores the current loadout by design (it is a stable fixed
 * point), so a second apply reports `changed: false` and re-applying cannot
 * duplicate or oscillate entries. An explicit apply is the **only** path that
 * replaces a hand-picked loadout; building the model never mutates payload
 * (producer Q1 = B).
 *
 * @param payload — the persistent war payload (never mutated).
 * @param catalogue — the tree ownership is resolved against (defaults shipped).
 * @param target — the target hex's authored lists (the model's `bossIntel`),
 *   or `null` for an unauthored/unknown target (every weapon neutral).
 * @returns whether anything changed, the applied suggestion and the fresh
 *   payload to persist.
 */
export function applyAutoLoadout(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
  target: MatchupDefinition | null = null,
): HangarBuildoutApplyResult {
  const suggestion = selectAutoLoadout(payload, target, catalogue);
  const current = resolveActiveLoadout(payload.hangar, catalogue);
  const next = clonePayload(payload);
  next.hangar = equipLoadout(payload.hangar, {
    startingWeapons: [...suggestion.startingWeapons],
    modifiers: payload.hangar.activeLoadout.modifiers,
    powerUps: suggestion.grantedPowerUps.map((pick) => pick.id),
  });
  const applied = resolveActiveLoadout(next.hangar, catalogue);
  return {
    changed: !sameIds(applied.startingWeapons, current.startingWeapons)
      || !sameIds(applied.powerUps ?? [], current.powerUps ?? []),
    suggestion,
    payload: next,
  };
}

/** Whether two id lists are equal in order and content. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Toggles one owned starting weapon in the active loadout (pure).
 *
 * Every toggle is allowed, including removing the last equipped weapon: an
 * empty starting-weapon selection is a legal loadout, so the player can deploy
 * with only the ship's permanent cannon (AH-0MVZJ6V1J001DA9D). The result
 * reports whether the requested change actually landed.
 */
export function toggleHangarWeapon(
  payload: HangarWarPayload,
  weaponId: string,
): HangarUpdateResult {
  const current = resolveActiveLoadout(payload.hangar).startingWeapons;
  const equipped = current.includes(weaponId);
  const requested = equipped
    ? current.filter((id) => id !== weaponId)
    : [...current, weaponId];
  const next = clonePayload(payload);
  next.hangar = equipLoadout(payload.hangar, {
    startingWeapons: requested,
    modifiers: payload.hangar.activeLoadout.modifiers,
    // Carry the raw tri-state through untouched so a weapon toggle never
    // materialises an absent selection or drops an explicit one.
    powerUps: payload.hangar.activeLoadout.powerUps,
  });
  const applied = resolveActiveLoadout(next.hangar).startingWeapons;
  return {
    ok: equipped
      ? !applied.includes(weaponId)
      : applied.includes(weaponId),
    reason: null,
    payload: next,
  };
}

/**
 * Toggles one owned permanent modifier on the active loadout (pure).
 *
 * Unlike starting weapons there is no minimum: a fleet may deploy with no
 * modifier at all, so toggling is always allowed for an owned modifier.
 */
export function toggleHangarModifier(
  payload: HangarWarPayload,
  modifierId: string,
): HangarUpdateResult {
  const current = resolveActiveLoadout(payload.hangar).modifiers;
  const equipped = current.includes(modifierId);
  const requested = equipped
    ? current.filter((id) => id !== modifierId)
    : [...current, modifierId];
  const next = clonePayload(payload);
  next.hangar = equipLoadout(payload.hangar, {
    startingWeapons: payload.hangar.activeLoadout.startingWeapons,
    modifiers: requested,
    // Preserve the raw power-up tri-state across a modifier toggle.
    powerUps: payload.hangar.activeLoadout.powerUps,
  });
  const applied = resolveActiveLoadout(next.hangar).modifiers;
  return {
    ok: equipped ? !applied.includes(modifierId) : applied.includes(modifierId),
    reason: null,
    payload: next,
  };
}

/**
 * Toggles one owned level-bearing power-up in the deployment selection (pure).
 *
 * The selection is read through `resolveActiveLoadout`, so the first toggle on
 * a save without the field starts from **every owned power-up** (today's
 * behaviour) and then writes an explicit list — deselecting one keeps the
 * rest selected. The write routes through `equipLoadout`, which filters the
 * list to owned, catalogue-known, level-bearing ids, so a corrupt or stale id
 * can never be installed. An empty selection (`[]`) is legal: the player may
 * deploy with no power-up installed.
 *
 * Toggling changes the **selection**, not the six-slot accounting; the
 * deployment's shared cap still trims what the run actually grants, and the
 * screen marks a selected-but-trimmed row `blocked` through the same rule.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param powerUpId — the owned power-up id to toggle.
 * @returns the fresh payload and whether the requested change landed.
 */
export function toggleHangarPowerUp(
  payload: HangarWarPayload,
  powerUpId: string,
): HangarUpdateResult {
  const ownedPowerUps = ownedLevelBearingPowerUpLevels(payload.hangar).map(
    (row) => row.id as string,
  );
  // An unowned/unknown/non-level-bearing id is a no-op that leaves the raw
  // tri-state untouched (absent stays absent), so a stale UI can never
  // materialise a selection from an id the economy would drop.
  if (!ownedPowerUps.includes(powerUpId)) {
    return { ok: false, reason: null, payload: clonePayload(payload) };
  }
  const current = resolveActiveLoadout(payload.hangar).powerUps ?? [];
  const selected = current.includes(powerUpId);
  const requested = selected
    ? current.filter((id) => id !== powerUpId)
    : [...current, powerUpId];
  const next = clonePayload(payload);
  next.hangar = equipLoadout(payload.hangar, {
    startingWeapons: payload.hangar.activeLoadout.startingWeapons,
    modifiers: payload.hangar.activeLoadout.modifiers,
    powerUps: requested,
  });
  const applied = resolveActiveLoadout(next.hangar).powerUps ?? [];
  return {
    ok: selected
      ? !applied.includes(powerUpId)
      : applied.includes(powerUpId),
    reason: null,
    payload: next,
  };
}

/**
 * Resets the war to its documented starting position (pure).
 *
 * Returns a **fresh** payload with the hangar back to its starting kit (the
 * basic hull and the starter weapon owned but **not equipped**, no modifiers,
 * zero salvage and an empty loadout), the ring back to `ringIndex` 1 with no
 * hexes, `pendingAttacks` empty and `frontierTick` 0. Two things are carried
 * across the reset:
 *
 * - **`bestScore` is preserved** — the all-time hangar-war record survives the
 *   reset (operator decision Q2 = b), so a restart never erases the best score.
 * - **A fresh random seed** — the caller supplies one (production uses the
 *   shared `randomSeed()`; tests inject a fixed seed), so a restart starts a
 *   genuinely new war (operator decision Q3 = a).
 *
 * The input payload is never mutated (it is a pure updater beside
 * {@link purchaseHangarEntry}/{@link equipHangarHull}/{@link toggleHangarWeapon}/
 * {@link toggleHangarModifier}); the caller persists the result through
 * `hangarWarStore`. The payload schema is unchanged: a reset refills the
 * existing v1 shape, so there is no version bump and no migration
 * (AH-0MW8F7NH1002PQE3).
 *
 * @param payload — the payload to reset (never mutated).
 * @param seed — the fresh war's seed (normalised by `createDefaultPayload`).
 * @returns a fresh payload in the starting position with `bestScore` kept.
 */
export function restartHangarWar(
  payload: HangarWarPayload,
  seed: number,
): HangarWarPayload {
  const fresh = createDefaultPayload(seed);
  // Saved builds survive a war reset (AH-0MWL8C6FE008G1E7): they are a
  // "what you own" meta-layer, not war progress, so thread them through
  // beside `bestScore` while the rest of the hangar resets to starters.
  return {
    ...fresh,
    hangar: {
      ...fresh.hangar,
      savedBuilds: payload.hangar.savedBuilds,
    },
    bestScore: toCount(payload.bestScore),
  };
}

// ── Saved ship configurations (AH-0MWL8C6FE008G1E7) ───────────────────────
//
// Four pure payload updaters + the name-entry keystroke helpers. The screen
// only presents and persists: capture (save), apply, rename and delete all
// delegate the economy/payload work to the pure core and return a fresh
// payload for the single `saveHangarWarPayload` write.

/**
 * The result of applying a saved build through the screen updater.
 */
export interface HangarBuildApplyResult {
  /** Whether the whole build was purchased and equipped. */
  readonly ok: boolean;
  /** The first blocking reason, or `'unknown-build'` when the id is gone. */
  readonly reason: SavedBuildRefusalReason | 'unknown-build' | null;
  /** The exact shortfall (zeroes when ok). */
  readonly shortfall: SavedBuildShortfall;
  /** The payload after the update (fresh; the input is untouched). */
  readonly payload: HangarWarPayload;
}

/** The empty shortfall the updater reports on success. */
const EMPTY_SAVED_BUILD_SHORTFALL: SavedBuildShortfall = Object.freeze({
  entries: [],
  minerals: 0,
  cores: 0,
});

/**
 * Applies a saved build — purchases and equips every part atomically, or
 * refuses with the exact shortfall and applies nothing (pure, AC2/AC3/AC6).
 *
 * Delegates the atomic apply to the economy's one `applySavedBuild` reducer
 * with the war's ring context, then writes the fresh hangar into a fresh
 * payload. An unknown build id (`'unknown-build'`) is the only refusal that
 * is not the economy's — it means the id was deleted after the UI listed it.
 * Persisting the result is the caller's one `saveHangarWarPayload` call.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param buildId — the saved build's id.
 * @returns the apply outcome and the payload to persist.
 */
export function applyHangarBuild(
  payload: HangarWarPayload,
  buildId: string,
): HangarBuildApplyResult {
  const builds = payload.hangar.savedBuilds ?? [];
  const build = builds.find((candidate) => candidate.id === buildId);
  if (build === undefined) {
    return {
      ok: false,
      reason: 'unknown-build',
      shortfall: EMPTY_SAVED_BUILD_SHORTFALL,
      payload: clonePayload(payload),
    };
  }
  const result = applySavedBuild(payload.hangar, build, {
    ringIndex: payload.ring.ringIndex,
  });
  const next = clonePayload(payload);
  next.hangar = result.hangar;
  return {
    ok: result.ok,
    reason: result.reason,
    shortfall: result.shortfall,
    payload: next,
  };
}

/**
 * Captures the currently equipped ship as a named saved build (pure, AC1).
 *
 * The id is the caller-supplied stable id (the pure core never invents one),
 * so a scene can keep using the same id for an overwrite. Saving never spends
 * currency. Persisting the result is the caller's one `saveHangarWarPayload`
 * call.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param id — the stable build id for the new/overwritten entry.
 * @param name — the display name (trimmed and length-bounded).
 * @returns a fresh payload carrying the captured build.
 */
export function saveHangarBuild(
  payload: HangarWarPayload,
  id: string,
  name: string,
): HangarWarPayload {
  const build = captureShipBuild(payload.hangar, { id, name });
  const next = clonePayload(payload);
  const builds = [...(next.hangar.savedBuilds ?? [])];
  const index = builds.findIndex((candidate) => candidate.id === id);
  if (index >= 0) builds[index] = build;
  else builds.push(build);
  next.hangar.savedBuilds = builds;
  return next;
}

/**
 * Renames a saved build, keeping its id stable (pure, AC4).
 *
 * An unknown id leaves the payload unchanged (a fresh, unmutated clone), so a
 * stale UI selection can never resurrect a deleted build.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param buildId — the saved build's id.
 * @param name — the new display name (trimmed and length-bounded).
 * @returns a fresh payload with the renamed build, or unchanged for an unknown id.
 */
export function renameHangarBuild(
  payload: HangarWarPayload,
  buildId: string,
  name: string,
): HangarWarPayload {
  const next = clonePayload(payload);
  const builds = next.hangar.savedBuilds ?? [];
  const index = builds.findIndex((candidate) => candidate.id === buildId);
  if (index < 0) return next;
  const trimmed = name.trim().slice(0, MAX_SAVED_BUILD_NAME_LENGTH);
  if (trimmed === '') return next;
  builds[index] = { ...builds[index], name: trimmed };
  return next;
}

/**
 * Deletes a saved build (pure, AC4/AC5).
 *
 * Deletion is reachable for every entry because every saved build gets its own
 * delete row. An unknown id is a no-op. Persisting the result is the caller's
 * one `saveHangarWarPayload` call.
 *
 * @param payload — the persistent war payload (never mutated).
 * @param buildId — the saved build's id.
 * @returns a fresh payload without the build.
 */
export function deleteHangarBuild(
  payload: HangarWarPayload,
  buildId: string,
): HangarWarPayload {
  const next = clonePayload(payload);
  const builds = next.hangar.savedBuilds ?? [];
  next.hangar.savedBuilds = builds.filter((candidate) => candidate.id !== buildId);
  return next;
}

/**
 * Whether a keystroke contributes a printable character to a build name
 * (child AH-0MWLE95BV000MWGF).
 *
 * Printable letters/digits/space are accepted; everything else (arrows, Enter,
 * Backspace, Escape, Tab) is a command the scene handles before this check.
 */
export function isNameEntryChar(key: string): boolean {
  if (key.length !== 1) return false;
  return (
    (key >= 'a' && key <= 'z') ||
    (key >= 'A' && key <= 'Z') ||
    (key >= '0' && key <= '9') ||
    key === ' '
  );
}

/**
 * Appends one printable character to a name-entry buffer (pure).
 *
 * Upper-cases the character (the game has no text cursor), and ignores the
 * key once the buffer is at {@link MAX_SAVED_BUILD_NAME_LENGTH} so a name can
 * never grow past the persisted bound.
 */
function appendNameEntryChar(buffer: string, key: string): string {
  if (!isNameEntryChar(key)) return buffer;
  if (buffer.length >= MAX_SAVED_BUILD_NAME_LENGTH) return buffer;
  const upper = key === ' ' ? ' ' : key.toUpperCase();
  return buffer + upper;
}

/** Backspace on a name-entry buffer (pure): drops the last character. */
export function backspaceNameEntry(buffer: string): string {
  return buffer.slice(0, -1);
}

/**
 * The pure name-entry transition the scene feeds every captured key: a
 * printable char appends, backspace drops, and anything else is a no-op.
 *
 * The scene owns the mode (save vs rename) and the submit keys (Enter
 * commits, Esc cancels) — this helper only turns raw keys into buffer
 * changes, so the keystroke rules are table-testable without a scene.
 *
 * @param buffer — the current name buffer.
 * @param key — the captured key (Phaser/KeyboardEvent `key` value).
 * @returns the next buffer.
 */
export function advanceNameEntry(buffer: string, key: string): string {
  if (key === 'Backspace') return backspaceNameEntry(buffer);
  return appendNameEntryChar(buffer, key);
}

/** Whether a non-empty trimmed name can be committed. */
export function isCommitableNameEntry(buffer: string): boolean {
  return buffer.trim() !== '';
}

/**
 * The events the two-step restart confirm reacts to.
 *
 * The scene owns the armed bit and its timer; this union is the pure input the
 * transition function consumes, so the confirm semantics are table-testable
 * without a scene (AH-0MW8F7NH1002PQE3).
 */
export type HangarRestartEvent =
  | { readonly kind: 'activate' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'focus'; readonly key: string | null }
  | { readonly kind: 'leave' };

/** The outcome of one {@link advanceRestartConfirm} transition. */
export interface HangarRestartTransition {
  /** The armed state after the event. */
  readonly armed: boolean;
  /** True only when this event commits the reset (the second activation). */
  readonly reset: boolean;
}

/**
 * The pure two-step confirm state machine for the restart row
 * (AH-0MW8F7NH1002PQE3).
 *
 * Starting from `armed`:
 *
 * - **`activate`** — idle → arms (no reset); armed → **commits the reset** and
 *   disarms. This is why a stray Enter only ever arms; a second deliberate
 *   activation is required to wipe the war.
 * - **`timeout`** — always disarms (the confirm window expired).
 * - **`focus`** — moving focus away from the restart row disarms; focusing the
 *   restart row itself leaves the state untouched.
 * - **`leave`** — leaving the screen always disarms.
 *
 * @param armed — whether the row is currently armed.
 * @param event — the event to apply.
 * @returns the next armed bit and whether this event commits the reset.
 */
export function advanceRestartConfirm(
  armed: boolean,
  event: HangarRestartEvent,
): HangarRestartTransition {
  switch (event.kind) {
    case 'activate':
      return armed
        ? { armed: false, reset: true }
        : { armed: true, reset: false };
    case 'timeout':
      return { armed: false, reset: false };
    case 'focus':
      // Only focus moving to another row disarms; focus staying on (or moving
      // to) the restart row keeps the confirm step intact.
      return { armed: event.key === RESTART_ROW_KEY ? armed : false, reset: false };
    case 'leave':
      return { armed: false, reset: false };
  }
}

/** Optional rendering knobs for {@link renderHangarScreen}. */
export interface HangarScreenRenderOptions {
  /** Bottom hint line (defaults to {@link HANGAR_SCREEN_HINT}). */
  readonly hint?: string;
  /**
   * Invoked after every focus change with the newly focused row key (or `null`
   * when no row is focusable). The shipped scene uses it to disarm the restart
   * row whenever focus leaves it, so the two-step confirm cannot survive a
   * focus move (AH-0MW8F7NH1002PQE3).
   */
  readonly onFocusChange?: (key: string | null) => void;
}

/** The actions a rendered hangar screen invokes. */
export interface HangarScreenHandlers {
  /** Buy an unlock (`BUY` rows only). */
  onBuy(entryId: string): void;
  /** Buy the next permanent level of an owned kind (`UPGRADE` rows only). */
  onUpgrade(kindId: string): void;
  /** Equip an owned hull. */
  onEquipHull(hullId: string): void;
  /** Toggle an owned starting weapon in the loadout. */
  onToggleWeapon(weaponId: string): void;
  /** Toggle an owned level-bearing power-up in the deployment selection. */
  onTogglePowerUp(powerUpId: string): void;
  /** Toggle an owned permanent modifier on the loadout. */
  onToggleModifier(modifierId: string): void;
  /**
   * Equip the suggested buildout (the `⚡ APPLY SUGGESTED BUILDOUT` row).
   *
   * Optional so a read-only render — the gym, a preview — can present the row
   * with the identical label while activating nothing
   * (AH-0MWOWEF3Q008BO5J). The screen wires it to `applyAutoLoadout`.
   */
  onApplyBuildout?(): void;
  /** Launch a deployment at `hexId` (the ▶ DEPLOY row). */
  onDeploy(hexId: string | null): void;
  /** Open the hex map (the `⌗ HEX MAP` row). */
  onOpenMap(): void;
  /** Reset the war to its starting position (the `⟲ RESTART WAR` row). */
  onRestart(): void;
  /** Capture the current ship as a saved build (the `＋ SAVE` row). */
  onSaveBuild?(): void;
  /** Advance the selected saved build (the `◀ ▶ SAVED BUILD` row). */
  onCycleBuild?(): void;
  /** Purchase and equip the selected saved build (the `▶ FLY` row). */
  onApplyBuild?(buildId: string): void;
  /** Rename the selected saved build (the `✎ RENAME` row). */
  onRenameBuild?(buildId: string): void;
  /** Delete the selected saved build (the `✖ DELETE` row). */
  onDeleteBuild?(buildId: string): void;
}

/** Optional model-building knobs for {@link buildHangarScreenModel}. */
export interface HangarScreenModelOptions {
  /**
   * Whether the restart row is armed (the second step of the two-step confirm).
   * Defaults to `false` (idle).
   */
  readonly restartArmed?: boolean;
  /**
   * The hex the player chose on the map (transient launch data). When omitted
   * the model describes the deployment's own default — the weakest unheld hex
   * — so the intel always names the hex `▶ DEPLOY` would actually launch at.
   */
  readonly targetHexId?: string | null;
  /**
   * The authored ring definitions to read (injectable for tests/fixtures).
   * Defaults to the shipped `HEX_RING_DEFINITIONS`, so the game and the gym
   * can never present a scene-local copy of the intel.
   */
  readonly definitions?: readonly HexRingDefinition[];
  /**
   * The index of the currently selected saved build (the drop-down position).
   * Clamped to the list; defaults to the first build (AH-0MWL8C6FE008G1E7).
   */
  readonly savedBuildIndex?: number;
  /**
   * A transient message to show above the restart row (e.g. an apply
   * refusal's shortfall). `null`/omitted renders nothing.
   */
  readonly savedBuildMessage?: string | null;
}

/** One rendered row, exposed for tests and screen queries. */
export interface HangarScreenRow {
  /** Row key (matches {@link HangarScreenModel.focusOrder}). */
  key: string;
  /** Rendered text. */
  label: string;
  /** Whether the row can be activated. */
  actionable: boolean;
  /**
   * The weapon's matchup verdict rendered for this row, or `null` for a
   * non-weapon row (which keeps its existing rendering).
   */
  matchup: BossMatchup | null;
  /** The Phaser text object rendering the row. */
  text: Phaser.GameObjects.Text;
}

/** The handle returned by {@link renderHangarScreen}. */
export interface HangarScreenView {
  /** The model rendered (detached from any caller state). */
  readonly model: HangarScreenModel;
  /** Every rendered row, in reading order. */
  readonly rows: readonly HangarScreenRow[];
  /** The focused row key, or `null` when no row is focusable. */
  getFocusedKey(): string | null;
  /** Moves focus to `key` when it is focusable (deterministic test seam). */
  focusRow(key: string): boolean;
  /** Activates the focused row (what Enter/Space does). */
  activateFocused(): void;
  /**
   * The first unlock-tree row currently visible (the scroll offset, in rows).
   * `0` when the whole tree fits or nothing has scrolled.
   */
  getUnlockScroll(): number;
  /**
   * Scrolls the unlock tree by `delta` rows (positive = down), clamped to the
   * model. Returns the applied offset so a caller can assert the clamp.
   */
  scrollUnlockRows(delta: number): number;
  /** Whether `key` is an unlock row inside the visible window (test seam). */
  isUnlockRowVisible(key: string): boolean;
  /**
   * The pointer scroll affordances rendered beside the unlock tree. They are
   * not model rows (so the keyboard focus order is unchanged), but a pointer
   * user can click them to reveal the rows either side of the window.
   */
  readonly scrollControls: {
    readonly up: Phaser.GameObjects.Text;
    readonly down: Phaser.GameObjects.Text;
  };
  /** Destroys the rendered objects and detaches the keyboard listener. */
  destroy(): void;
}

/** Neon colours reused across rows (GDD §7.1). */
const ROW_COLOR = '#00ff88';
const DISABLED_COLOR = '#555555';
const HEADING_COLOR = '#00ffff';
const TEXT_COLOR = '#88ffff';

/**
 * Matchup highlight colours (AH-0MWMT4QXF0095CBN).
 *
 * The glyph tag is the primary signal and these colours are the secondary one
 * (repo CVD policy: never colour-only). Both are deliberately distinct from the
 * ordinary actionable green ({@link ROW_COLOR}) and disabled grey
 * ({@link DISABLED_COLOR}).
 */
export const HANGAR_STRONG_COLOR = '#aaff00';
export const HANGAR_WEAK_COLOR = '#ff5577';

/**
 * Backing tints for the matchup rows, so a strong/weak row is still
 * recognisable as a highlight without relying on the hue.
 */
export const HANGAR_STRONG_BACKGROUND = '#162600';
export const HANGAR_WEAK_BACKGROUND = '#2a000c';

/** The labelled target-intel section (AH-0MWMT4QXF0095CBN). */
export const HANGAR_INTEL_HEADING = 'TARGET INTEL';
export const HANGAR_INTEL_BOSS_LABEL = 'BOSS';
export const HANGAR_INTEL_STRENGTHS_LABEL = 'STRENGTHS';
export const HANGAR_INTEL_WEAKNESSES_LABEL = 'WEAKNESSES';
/** The explicit fallback an unknown/unauthored hex renders. */
export const HANGAR_INTEL_UNKNOWN = 'unknown';
/** An authored list with no entries renders as this (not "unknown"). */
export const HANGAR_INTEL_NONE = 'none';
/** The heading suffix when the war has no target hex (an empty ring). */
export const HANGAR_INTEL_NO_HEX = 'no hex';

/** Layout constants (single-source so the game and the gym match). */
const LEFT_X = 60;
const RIGHT_X = 520;
const TITLE_Y = 34;
const SALVAGE_Y = 70;
const RING_Y = 90;
const SECTION_Y = 118;
const ROW_START_Y = 144;

/** Vertical step between rows in either column. */
export const HANGAR_ROW_STEP = 16;

/**
 * Y positions of the target-intel block (top-left, above the unlock tree).
 * Exported so the layout assertion pins the same geometry the renderer draws.
 */
export const HANGAR_INTEL_HEADING_Y = 112;
export const HANGAR_INTEL_FIRST_LINE_Y = 132;
export const HANGAR_INTEL_LINE_STEP = 18;

/** Y of the `UNLOCKS` heading and of the first unlock-tree row beneath it. */
export const HANGAR_UNLOCKS_HEADING_Y = 190;
export const HANGAR_UNLOCK_ROW_START_Y = 210;

/** The Y of unlock-tree row `index` (single-sourced with the renderer). */
export function hangarUnlockRowY(index: number): number {
  return HANGAR_UNLOCK_ROW_START_Y + index * HANGAR_ROW_STEP;
}

/**
 * The unlock tree is taller than the space above the fixed bottom block at the
 * full 23-row roster, so it renders through a fixed-height **viewport** and
 * scrolls instead of colliding with the buildout/restart/map/deploy rows
 * (AH-0MWWI3ONJ004QRR9).
 *
 * The window holds 12 rows (12 × 16 px = 192 px), ending one row step above the
 * pointer scroll affordance and two steps above the top bottom-block slot
 * (`HANGAR_BUILDOUT_ROW_Y`). Every constant is single-sourced with the renderer
 * and the layout spec, so a future roster change cannot silently reintroduce
 * the collision.
 */
export const HANGAR_UNLOCK_VISIBLE_ROWS = 12;

/** The Y of the first row inside the unlock viewport (the top of the window). */
export const HANGAR_UNLOCK_VIEWPORT_TOP_Y = HANGAR_UNLOCK_ROW_START_Y;

/** The Y of the last row that fits inside the unlock viewport. */
export const HANGAR_UNLOCK_VIEWPORT_BOTTOM_Y =
  HANGAR_UNLOCK_ROW_START_Y
  + (HANGAR_UNLOCK_VISIBLE_ROWS - 1) * HANGAR_ROW_STEP;

/**
 * The Y of the pointer scroll affordance, directly beneath the viewport and
 * above the fixed bottom block.
 */
export const HANGAR_UNLOCK_SCROLL_INDICATOR_Y =
  HANGAR_UNLOCK_ROW_START_Y + HANGAR_UNLOCK_VISIBLE_ROWS * HANGAR_ROW_STEP;

/**
 * The largest scroll offset (in rows) the unlock viewport allows. `0` when the
 * whole tree fits, so callers can treat a scrollable list and a short one alike.
 */
export function hangarUnlockMaxScroll(
  model: Pick<HangarScreenModel, 'unlockRows'>,
): number {
  return Math.max(0, model.unlockRows.length - HANGAR_UNLOCK_VISIBLE_ROWS);
}

/**
 * The scroll offset that keeps unlock row `index` inside the visible window.
 *
 * Pure and total: the renderer, the pointer affordances and the navigation
 * spec share this one rule, so a focused row can never be scrolled out of view.
 * The returned offset is not clamped to the model's maximum — the caller clamps
 * it once against {@link hangarUnlockMaxScroll}.
 */
export function hangarUnlockScrollForFocus(
  index: number,
  scroll: number,
): number {
  if (index < scroll) return index;
  if (index >= scroll + HANGAR_UNLOCK_VISIBLE_ROWS) {
    return index - HANGAR_UNLOCK_VISIBLE_ROWS + 1;
  }
  return scroll;
}

/** Whether unlock row `index` is inside the window at scroll offset `scroll`. */
export function hangarUnlockRowVisible(
  index: number,
  scroll: number,
): boolean {
  return index >= scroll && index < scroll + HANGAR_UNLOCK_VISIBLE_ROWS;
}

/** The right-hand column's section and row geometry (single-sourced). */
export interface HangarRightColumnLayout {
  readonly hullRowY: readonly number[];
  readonly loadoutHeadingY: number;
  readonly weaponRowY: readonly number[];
  /** Y of each installed power-up row (in the LOADOUT block, after weapons). */
  readonly powerUpRowY: readonly number[];
  readonly modifierHeadingY: number;
  readonly modifierRowY: readonly number[];
  /** Y of the `SAVED BUILDS` heading (below the modifiers). */
  readonly savedBuildHeadingY: number;
  /** Y of each saved-build row (below the heading). */
  readonly savedBuildRowY: readonly number[];
}

/**
 * Derives every Y in the right-hand column from the model's row counts, so the
 * renderer and the layout test read one geometry and a new row cannot silently
 * collide with the fixed bottom-row block.
 *
 * The saved-build surface is **compact and fixed-height** (one save row plus a
 * cycle/apply/rename/delete block for the selected build), so an unbounded
 * saved-build list never grows this geometry: the selected index cycles
 * instead of adding rows (AH-0MWL8C6FE008G1E7).
 */
export function hangarRightColumnLayout(
  model: Pick<
    HangarScreenModel,
    'hullOptions' | 'weaponOptions' | 'powerUpOptions' | 'modifierOptions' | 'savedBuildRows'
  >,
): HangarRightColumnLayout {
  const hullRowY = model.hullOptions.map(
    (_, index) => ROW_START_Y + index * HANGAR_ROW_STEP,
  );
  const loadoutHeadingY =
    ROW_START_Y + model.hullOptions.length * HANGAR_ROW_STEP + 10;
  const weaponRowY = model.weaponOptions.map(
    (_, index) => loadoutHeadingY + 26 + index * HANGAR_ROW_STEP,
  );
  // Power-ups share the LOADOUT block, listed after the weapons, so the extra
  // section needs no second heading (the layout already holds a lot of rows).
  const powerUpRowY = model.powerUpOptions.map(
    (_, index) =>
      loadoutHeadingY
      + 26
      + (model.weaponOptions.length + index) * HANGAR_ROW_STEP,
  );
  const loadoutRows = model.weaponOptions.length + model.powerUpOptions.length;
  const modifierHeadingY =
    loadoutHeadingY + 26 + loadoutRows * HANGAR_ROW_STEP + 10;
  const modifierRowY = model.modifierOptions.map(
    (_, index) => modifierHeadingY + 26 + index * HANGAR_ROW_STEP,
  );
  const savedBuildHeadingY =
    modifierHeadingY + 26 + model.modifierOptions.length * HANGAR_ROW_STEP + 10;
  const savedBuildRowY = model.savedBuildRows.map(
    (_, index) => savedBuildHeadingY + 26 + index * HANGAR_ROW_STEP,
  );
  return {
    hullRowY,
    loadoutHeadingY,
    weaponRowY,
    powerUpRowY,
    modifierHeadingY,
    modifierRowY,
    savedBuildHeadingY,
    savedBuildRowY,
  };
}

/**
 * The lowest row Y the **unscrolled** model geometry reaches.
 *
 * This is the height the tree would occupy without a viewport: at the full
 * 23-row roster it extends past the fixed bottom block, which is exactly why
 * the renderer scrolls the unlock tree (AH-0MWWI3ONJ004QRR9). The layout spec
 * therefore asserts overflow against this value and checks that the *visible
 * window* ({@link HANGAR_UNLOCK_VIEWPORT_BOTTOM_Y}) and the right column stay
 * above {@link HANGAR_RESTART_ROW_Y}.
 */
export function hangarLowestRowY(model: HangarScreenModel): number {
  const right = hangarRightColumnLayout(model);
  const ys = [
    ...model.unlockRows.map((_, index) => hangarUnlockRowY(index)),
    ...right.hullRowY,
    ...right.weaponRowY,
    ...right.powerUpRowY,
    ...right.modifierRowY,
    ...right.savedBuildRowY,
  ];
  return ys.length === 0 ? 0 : Math.max(...ys);
}

/**
 * Y positions of the fixed bottom-row block (bottom of the screen, above the
 * hint line). Exported so a layout assertion can pin the spacing and so no
 * row silently collides as the block grows.
 *
 * Reading order on screen is buildout → restart → map → deploy, each 22 px
 * apart, with the primary deployment action closest to the hint line
 * (AH-0MW8F7NH1002PQE3; the buildout row joined the block in
 * AH-0MWOWEF3Q008BO5J).
 */
export const HANGAR_DEPLOY_ROW_Y = GAME_HEIGHT - 52;
export const HANGAR_MAP_ROW_Y = GAME_HEIGHT - 74;
export const HANGAR_RESTART_ROW_Y = GAME_HEIGHT - 96;
/**
 * Y of the `⚡ APPLY SUGGESTED BUILDOUT` row — the top slot of the fixed
 * bottom-row block, above the destructive restart row (AH-0MWOWEF3Q008BO5J).
 *
 * Keeping it in the fixed block means the row can never collide with a growing
 * unlock tree or loadout list; it sits directly above the deployment it feeds.
 */
export const HANGAR_BUILDOUT_ROW_Y = GAME_HEIGHT - 118;

/** Scene-level objects created by the renderer (destroyed together). */
interface RenderedRows {
  objects: Phaser.GameObjects.Text[];
  rows: HangarScreenRow[];
  byKey: Map<string, HangarScreenRow>;
}

/** Renders a heading text. */
function heading(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.Text[],
  x: number,
  y: number,
  label: string,
): void {
  objects.push(
    scene.add.text(x, y, label, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: HEADING_COLOR,
    }),
  );
}

/** The row colour for a matchup verdict, falling back to the existing ones. */
function rowColour(actionable: boolean, matchup: BossMatchup | null): string {
  if (matchup === 'strong') return HANGAR_STRONG_COLOR;
  if (matchup === 'weak') return HANGAR_WEAK_COLOR;
  return actionable ? ROW_COLOR : DISABLED_COLOR;
}

/** The backing tint for a matchup row (`undefined` keeps the plain style). */
function rowBackground(matchup: BossMatchup | null): string | undefined {
  if (matchup === 'strong') return HANGAR_STRONG_BACKGROUND;
  if (matchup === 'weak') return HANGAR_WEAK_BACKGROUND;
  return undefined;
}

/** Renders one row and returns its text object. */
function rowText(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.Text[],
  x: number,
  y: number,
  label: string,
  actionable: boolean,
  matchup: BossMatchup | null,
): Phaser.GameObjects.Text {
  const style: Phaser.Types.GameObjects.Text.TextStyle = {
    fontFamily: 'monospace',
    fontSize: '13px',
    color: rowColour(actionable, matchup),
  };
  const background = rowBackground(matchup);
  if (background !== undefined) style.backgroundColor = background;
  const text = scene.add.text(x, y, label, style);
  objects.push(text);
  return text;
}

/** An authored intel list as rendered (`unknown` when the hex is unauthored). */
function formatIntelList(list: readonly string[], known: boolean): string {
  if (!known) return HANGAR_INTEL_UNKNOWN;
  return list.length > 0 ? list.join(', ') : HANGAR_INTEL_NONE;
}

/** The three labelled intel lines the renderer draws under its heading. */
function intelLines(intel: HangarBossIntel): string[] {
  return [
    `${HANGAR_INTEL_BOSS_LABEL}: ${intel.boss ?? HANGAR_INTEL_UNKNOWN}`,
    `${HANGAR_INTEL_STRENGTHS_LABEL}: ${formatIntelList(intel.strengths, intel.known)}`,
    `${HANGAR_INTEL_WEAKNESSES_LABEL}: ${formatIntelList(intel.weaknesses, intel.known)}`,
  ];
}

/**
 * Renders the hangar screen model and wires its actionable rows to the shared
 * `FocusManager`.
 *
 * Disabled rows are rendered muted and are **not** made interactive and **not**
 * registered with the focus manager, so neither a pointer click nor a keyboard
 * activation can reach them. Pointer handlers are attached to actionable rows
 * only, and the focus activation callback is the same function the pointer
 * handler calls, so both input paths behave identically. A render with no
 * handlers (e.g. the read-only `GymHangar` parity scene) shows the same state
 * and colours but reports every row as non-actionable, because nothing on it
 * can be activated.
 *
 * @param scene — the scene that owns the rendered objects.
 * @param model — the model to render (from {@link buildHangarScreenModel}).
 * @param handlers — the actions the rows invoke (omit to render read-only).
 * @param options — rendering knobs (the bottom hint line).
 * @returns the view handle.
 */
export function renderHangarScreen(
  scene: Phaser.Scene,
  model: HangarScreenModel,
  handlers?: Partial<HangarScreenHandlers>,
  options?: HangarScreenRenderOptions,
): HangarScreenView {
  const objects: Phaser.GameObjects.Text[] = [];
  const rendered: RenderedRows = { objects, rows: [], byKey: new Map() };
  const focusManager = new FocusManager();

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, TITLE_Y, model.title, {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: HEADING_COLOR,
      })
      .setOrigin(0.5, 0),
  );
  objects.push(
    scene.add.text(LEFT_X, SALVAGE_Y, model.salvageLine, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: TEXT_COLOR,
    }),
  );
  objects.push(
    scene.add.text(LEFT_X, RING_Y, model.ringLine, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: TEXT_COLOR,
    }),
  );

  // ── Target intel (top, above the tree; labelled and never colour-only) ──
  heading(
    scene,
    objects,
    LEFT_X,
    HANGAR_INTEL_HEADING_Y,
    `${HANGAR_INTEL_HEADING} — ${model.bossIntel.hexId ?? HANGAR_INTEL_NO_HEX}`,
  );
  intelLines(model.bossIntel).forEach((line, index) => {
    objects.push(
      scene.add.text(
        LEFT_X,
        HANGAR_INTEL_FIRST_LINE_Y + index * HANGAR_INTEL_LINE_STEP,
        line,
        {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: TEXT_COLOR,
        },
      ),
    );
  });

  const addRow = (
    x: number,
    y: number,
    key: string,
    label: string,
    actionable: boolean,
    matchup: BossMatchup | null,
    action: (() => void) | undefined,
  ): void => {
    // A row is only *activatable* when the economy says it is AND this render
    // supplied a handler for it. A read-only render (the gym, a preview) shows
    // the same state, markers and colours but can activate nothing, so its rows
    // report `actionable: false` and never enter the focus cycle.
    const interactive = actionable && action !== undefined;
    const text = rowText(scene, objects, x, y, label, actionable, matchup);
    const row: HangarScreenRow = {
      key,
      label,
      actionable: interactive,
      matchup,
      text,
    };
    rendered.rows.push(row);
    rendered.byKey.set(key, row);
    if (!interactive || !action) return;
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setStyle({ color: '#ffffff' }));
    // Restore the row's own colour, never the plain actionable green: a
    // matchup-highlighted row must keep its highlight after the pointer leaves.
    text.on('pointerout', () =>
      text.setStyle({ color: rowColour(actionable, matchup) }),
    );
    text.on('pointerdown', () => action());
    focusManager.register(text, action);
  };

  // ── Unlock tree (left column, scrollable viewport) ──────────────
  // The full roster (23 rows) is taller than the space above the fixed bottom
  // block, so the tree renders through a fixed 12-row window and scrolls. The
  // window, keyboard focus auto-scroll and pointer affordances below share the
  // one geometry in `hangarScreen` (AH-0MWWI3ONJ004QRR9).
  heading(scene, objects, LEFT_X, HANGAR_UNLOCKS_HEADING_Y, 'UNLOCKS');

  // Pointer scroll affordances. They are deliberately **not** model rows and
  // not registered with the FocusManager, so the shipped keyboard focus order
  // (and every test pinning it) is unchanged; a keyboard-only player reaches
  // the same rows through focus auto-scroll below.
  const scrollUp = scene.add
    .text(LEFT_X + 130, HANGAR_UNLOCKS_HEADING_Y, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: HEADING_COLOR,
    })
    .setInteractive({ useHandCursor: true });
  const scrollDown = scene.add
    .text(LEFT_X + 130, HANGAR_UNLOCK_SCROLL_INDICATOR_Y, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: HEADING_COLOR,
    })
    .setInteractive({ useHandCursor: true });
  objects.push(scrollUp, scrollDown);

  const unlockRefs: Phaser.GameObjects.Text[] = [];
  let unlockScroll = 0;
  const maxUnlockScroll = (): number => hangarUnlockMaxScroll(model);
  const clampUnlockScroll = (value: number): number =>
    Math.min(Math.max(0, value), maxUnlockScroll());
  const unlockIndexFor = (key: string): number =>
    model.unlockRows.findIndex((row) => row.key === key);
  const applyUnlockScroll = (): void => {
    unlockScroll = clampUnlockScroll(unlockScroll);
    unlockRefs.forEach((text, index) => {
      text.setVisible(hangarUnlockRowVisible(index, unlockScroll));
      text.y =
        HANGAR_UNLOCK_VIEWPORT_TOP_Y
        + (index - unlockScroll) * HANGAR_ROW_STEP;
    });
    const moreAbove = unlockScroll > 0;
    const moreBelow = unlockScroll < maxUnlockScroll();
    scrollUp.setText(moreAbove ? '▲ MORE' : '').setVisible(moreAbove);
    scrollDown.setText(moreBelow ? '▼ MORE' : '').setVisible(moreBelow);
  };
  const scrollUnlockRows = (delta: number): number => {
    unlockScroll = clampUnlockScroll(unlockScroll + delta);
    applyUnlockScroll();
    return unlockScroll;
  };
  const ensureUnlockVisible = (key: string | null): void => {
    if (key === null) return;
    const index = unlockIndexFor(key);
    if (index < 0) return;
    unlockScroll = clampUnlockScroll(
      hangarUnlockScrollForFocus(index, unlockScroll),
    );
    applyUnlockScroll();
  };
  scrollUp.on('pointerdown', () => {
    scrollUnlockRows(-HANGAR_UNLOCK_VISIBLE_ROWS);
  });
  scrollDown.on('pointerdown', () => {
    scrollUnlockRows(HANGAR_UNLOCK_VISIBLE_ROWS);
  });

  model.unlockRows.forEach((row, index) => {
    // An owned level-bearing row is an **upgrade** row: it activates the
    // next-level purchase, not the (already-owned) unlock. Every other
    // actionable row stays on the purchase handler, so the two branches never
    // cross over.
    const isUpgradeRow =
      row.state === 'upgradable' || row.state === 'upgrade-unaffordable';
    const action = isUpgradeRow
      ? handlers?.onUpgrade
        ? () => handlers.onUpgrade!(row.id)
        : undefined
      : handlers?.onBuy
        ? () => handlers.onBuy!(row.id)
        : undefined;
    addRow(
      LEFT_X,
      hangarUnlockRowY(index),
      row.key,
      row.label,
      row.actionable,
      row.matchup,
      action,
    );
    unlockRefs.push(rendered.byKey.get(row.key)!.text);
  });
  // Position the initial window (and hide the rows below the fold).
  applyUnlockScroll();

  // ── Deployment selector (right column) ─────────────────────────
  const right = hangarRightColumnLayout(model);
  heading(scene, objects, RIGHT_X, SECTION_Y, 'HULLS');
  model.hullOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      right.hullRowY[index],
      option.key,
      option.label,
      option.actionable,
      null,
      handlers?.onEquipHull
        ? () => handlers.onEquipHull!(option.id)
        : undefined,
    );
  });

  heading(scene, objects, RIGHT_X, right.loadoutHeadingY, 'LOADOUT');
  model.weaponOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      right.weaponRowY[index],
      option.key,
      option.label,
      option.actionable,
      option.matchup,
      handlers?.onToggleWeapon
        ? () => handlers.onToggleWeapon!(option.id)
        : undefined,
    );
  });
  // Power-ups share the LOADOUT block (labelled `POWER-UP`), so a permanent
  // passive kind is toggled with the same affordance as a weapon without a
  // second heading (the right column is height-constrained).
  model.powerUpOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      right.powerUpRowY[index],
      option.key,
      option.label,
      option.actionable,
      null,
      handlers?.onTogglePowerUp
        ? () => handlers.onTogglePowerUp!(option.id)
        : undefined,
    );
  });

  heading(scene, objects, RIGHT_X, right.modifierHeadingY, 'MODIFIERS');
  model.modifierOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      right.modifierRowY[index],
      option.key,
      option.label,
      option.actionable,
      null,
      handlers?.onToggleModifier
        ? () => handlers.onToggleModifier!(option.id)
        : undefined,
    );
  });

  // ── Saved ship configurations (right column, below the modifiers) ──
  // A compact, fixed-height surface: `＋ SAVE` plus (when at least one build
  // exists) the cycle/apply/rename/delete rows for the selected build, so an
  // unbounded list never grows the screen (AH-0MWL8C6FE008G1E7).
  heading(scene, objects, RIGHT_X, right.savedBuildHeadingY, 'SAVED BUILDS');
  model.savedBuildRows.forEach((row, index) => {
    let action: (() => void) | undefined;
    switch (row.verb) {
      case 'save':
        action = handlers?.onSaveBuild
          ? () => handlers.onSaveBuild!()
          : undefined;
        break;
      case 'cycle':
        action = handlers?.onCycleBuild
          ? () => handlers.onCycleBuild!()
          : undefined;
        break;
      case 'apply':
        action =
          handlers?.onApplyBuild && row.buildId
            ? () => handlers.onApplyBuild!(row.buildId!)
            : undefined;
        break;
      case 'rename':
        action =
          handlers?.onRenameBuild && row.buildId
            ? () => handlers.onRenameBuild!(row.buildId!)
            : undefined;
        break;
      case 'delete':
        action =
          handlers?.onDeleteBuild && row.buildId
            ? () => handlers.onDeleteBuild!(row.buildId!)
            : undefined;
        break;
    }
    addRow(
      RIGHT_X,
      right.savedBuildRowY[index],
      row.key,
      row.label,
      row.actionable,
      null,
      action,
    );
  });

  // ── Apply suggested buildout (the loadout action, above DEPLOY) ──
  // Rendered from the model's published row, so the game and the gym show the
  // identical label; only the game supplies a handler (AH-0MWOWEF3Q008BO5J).
  addRow(
    LEFT_X,
    HANGAR_BUILDOUT_ROW_Y,
    model.buildoutRow.key,
    model.buildoutRow.label,
    model.buildoutRow.actionable,
    null,
    handlers?.onApplyBuildout
      ? () => handlers.onApplyBuildout!()
      : undefined,
  );

  // ── Deploy (bottom, the screen's primary action) ─────────────
  addRow(
    LEFT_X,
    HANGAR_DEPLOY_ROW_Y,
    model.deployRow.key,
    model.deployRow.label,
    model.deployRow.actionable,
    null,
    handlers?.onDeploy
      ? () => handlers.onDeploy!(model.deployRow.hexId)
      : undefined,
  );

  // ── Hex map (navigation, directly above the primary action) ──
  addRow(
    LEFT_X,
    HANGAR_MAP_ROW_Y,
    model.mapRow.key,
    model.mapRow.label,
    model.mapRow.actionable,
    null,
    handlers?.onOpenMap ? () => handlers.onOpenMap!() : undefined,
  );

  // ── Restart war (destructive, the top bottom-row slot) ──────
  addRow(
    LEFT_X,
    HANGAR_RESTART_ROW_Y,
    model.restartRow.key,
    model.restartRow.label,
    model.restartRow.actionable,
    null,
    handlers?.onRestart ? () => handlers.onRestart!() : undefined,
  );

  // ── Transient saved-build message (an apply refusal's shortfall) ──
  if (model.savedBuildMessage) {
    objects.push(
      scene.add.text(LEFT_X, HANGAR_RESTART_ROW_Y - 20, model.savedBuildMessage, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#d98a2b',
      }),
    );
  }

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 14, options?.hint ?? HANGAR_SCREEN_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#555555',
      })
      .setOrigin(0.5, 1),
  );

  const focusedKey = (): string | null => {
    const index = focusManager.getFocusedIndex();
    if (index < 0) return null;
    const focusable = rendered.rows.filter((row) => row.actionable);
    return focusable[index]?.key ?? null;
  };

  // Pointer scroll: a wheel over the screen moves the unlock window by one row
  // (only when the tree overflows, so a short list is never interceptable).
  const onWheel = (
    _pointer: Phaser.Input.Pointer,
    _over: readonly Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void => {
    if (maxUnlockScroll() === 0) return;
    scrollUnlockRows(deltaY > 0 ? 1 : -1);
  };
  scene.input?.on('wheel', onWheel);

  focusManager.attachKeyboard(scene);
  // Always observe focus: an unlock row that gains keyboard focus is scrolled
  // back into the window before the external listener reports it, so the grown
  // tree can never hide the focused row from a keyboard-only player.
  focusManager.setFocusChangeListener(() => {
    const key = focusedKey();
    ensureUnlockVisible(key);
    options?.onFocusChange?.(key);
  });
  // Seed the window: the default focus may be a row below the first page.
  ensureUnlockVisible(focusedKey());

  return {
    model,
    rows: rendered.rows,
    getFocusedKey: focusedKey,
    focusRow(key: string): boolean {
      const focusable = rendered.rows.filter((row) => row.actionable);
      const index = focusable.findIndex((row) => row.key === key);
      if (index < 0) return false;
      focusManager.setFocusedIndex(index);
      ensureUnlockVisible(key);
      return true;
    },
    activateFocused(): void {
      focusManager.activateFocused();
    },
    getUnlockScroll: () => unlockScroll,
    scrollUnlockRows,
    isUnlockRowVisible(key: string): boolean {
      const index = unlockIndexFor(key);
      return index >= 0 && hangarUnlockRowVisible(index, unlockScroll);
    },
    scrollControls: { up: scrollUp, down: scrollDown },
    destroy(): void {
      focusManager.shutdown();
      scene.input?.off('wheel', onWheel);
      for (const object of rendered.objects) object.destroy();
      rendered.objects.length = 0;
      rendered.rows.length = 0;
      rendered.byKey.clear();
    },
  };
}

/**
 * The starter weapon a fresh fleet owns (never auto-equipped).
 *
 * Kept as a named export for callers that need to point at the fleet's starter
 * in the loadout selector; emptying a loadout no longer falls back to it
 * (AH-0MVZJ6V1J001DA9D).
 */
export const HANGAR_FALLBACK_WEAPON_ID = STARTER_WEAPON_ID;

/** Whether the fleet owns a catalogue entry (exposed for the scene/tests). */
export function hangarOwnsEntry(
  payload: HangarWarPayload,
  entryId: string,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): boolean {
  const entry = findHangarEntry(entryId, catalogue);
  return entry !== null && ownsEntry(payload.hangar, entry);
}
