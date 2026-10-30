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
 *   ({@link purchaseHangarEntry}, {@link equipHangarHull},
 *   {@link toggleHangarWeapon}), which return a fresh payload.
 * - **The deployment is a launch, not a loadout rule.** The ▶ DEPLOY row is
 *   built from the same pure deployment payload builder the game's scene
 *   hands to `PlayScene` (`./hangarDeployment`), so the hull, starting
 *   weapons, modifiers and hex-aggression difficulty shown on the screen are
 *   exactly the ones a deployment carries (AH-0MVUXC2DD003HN0I).
 * - **One screen code path.** {@link buildHangarScreenModel} and
 *   {@link renderHangarScreen} are used by the shipped `HangarScene` *and* by
 *   the `GymHangar` parity scene (which renders the same model read-only), so
 *   the gym can never drift from the game (AGENTS.md gym↔game parity,
 *   `docs/GYM_PARITY.md`).
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
  type HangarEntry,
  type HangarEntryKind,
} from '../../data/hangarCatalogue';
import {
  buy,
  canBuy,
  cheapestUsefulUnlock,
  equipHull,
  equipLoadout,
  findHangarEntry,
  ownsEntry,
  resolveActiveHull,
  resolveActiveLoadout,
} from '../../core/hangarWar/hangarEconomy';
import type {
  HangarLoadout,
  HangarWarPayload,
  HexRingState,
} from '../../core/hangarWar/types';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarDeployment';
import { FocusManager } from '../../utils/focusManager';

/** Title rendered by the hangar screen (asserted by tests). */
export const HANGAR_SCREEN_TITLE = 'HANGAR WAR';

/** Bottom hint line advertising the shared keyboard controls. */
export const HANGAR_SCREEN_HINT =
  'tab/arrows move · enter/space select · ESC returns to the menu';

/** A hangar row's state — the economy's verdict, presented. */
export type HangarUnlockState = 'owned' | 'gated' | 'unaffordable' | 'buyable';

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
  /** Shown verb/state (`BUY`, `OWNED`, `RING 2`, `NEED 40 min`). */
  actionLabel: string;
  /** Full row text as rendered. */
  label: string;
  /** True only when the row can be bought right now. */
  actionable: boolean;
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

/** The complete rendered state of the hangar screen (pure data). */
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
  /** The ▶ DEPLOY row (the deployment this loadout launches). */
  deployRow: HangarDeployRow;
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
      },
    },
    ring: { ...payload.ring, hexes: payload.ring.hexes.map((hex) => ({ ...hex })) },
    pendingAttacks: payload.pendingAttacks.map((attack) => ({ ...attack })),
  };
}

/** The price of an entry as rendered (`FREE` for the starting kit). */
function formatPrice(entry: HangarEntry): string {
  if (entry.starter) return 'FREE';
  const minerals = toCount(entry.price.minerals);
  const cores = toCount(entry.price.cores);
  return cores > 0 ? `${minerals} min · ${cores} cores` : `${minerals} min`;
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
    case 'unaffordable': {
      const minerals = toCount(shortfall.minerals);
      const cores = toCount(shortfall.cores);
      const parts: string[] = [];
      if (minerals > 0) parts.push(`${minerals} min`);
      if (cores > 0) parts.push(`${cores} cores`);
      return `NEED ${parts.join(' / ')}`;
    }
    case 'buyable':
      return 'BUY';
  }
}

/**
 * Builds the unlock-tree rows for a hangar at a given ring.
 *
 * Every catalogue entry is presented, including the starter kit, so the tree
 * reads as a tree ("what I own and what is next"); the economy decides each
 * row's state with `owned` → `gated` → `unaffordable` precedence.
 *
 * @param payload — the payload whose hangar and ring are shown.
 * @param catalogue — the tree to present (injectable for tests/fixtures).
 * @returns the unlock rows, in catalogue order.
 */
export function buildHangarUnlockRows(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarUnlockRow[] {
  const context = { ringIndex: payload.ring.ringIndex };
  return catalogue.map((entry) => {
    const check = canBuy(payload.hangar, entry, context);
    const state: HangarUnlockState = check.ok
      ? 'buyable'
      : (check.reason ?? 'owned');
    const actionLabel = actionLabelFor(entry, state, check.shortfall);
    return {
      key: `buy:${entry.id}`,
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      priceLabel: formatPrice(entry),
      state,
      actionLabel,
      label: `${entry.name} — ${formatPrice(entry)} — ${actionLabel}`,
      actionable: state === 'buyable',
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
): HangarWeaponOption[] {
  const loadout = resolveActiveLoadout(payload.hangar);
  const equippedIds = new Set(loadout.startingWeapons);
  const options: HangarWeaponOption[] = [];
  for (const id of payload.hangar.unlockedWeapons) {
    const entry = findHangarEntry(id, catalogue);
    if (entry === null || entry.kind !== 'weapon') continue;
    const equipped = equippedIds.has(id);
    options.push({
      key: `weapon:${id}`,
      id,
      name: entry.name,
      equipped,
      label: `LOADOUT ${entry.name}${equipped ? ' — EQUIPPED' : ''}`,
      // The last equipped weapon can never be removed: a deployment always
      // starts armed (economy rule), so the row is disabled instead of
      // silently doing nothing.
      actionable: !equipped || equippedIds.size > 1,
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
 * Builds the ▶ DEPLOY row from the pure deployment payload (pure).
 *
 * The label states the target and the difficulty it selects — the same
 * `startLevel` the run will actually begin at — so the player can read the
 * hex-aggression difficulty before committing to the deployment.
 */
export function buildHangarDeployRow(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarDeployRow {
  const deployment: HangarWarDeployment = buildHangarDeployment(payload, {
    catalogue,
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
 * Reading order is the focus order: the unlock tree first, then hulls, then
 * the starting-weapon loadout. Only actionable rows enter the focus order.
 *
 * @param payload — the payload to present (never mutated).
 * @param catalogue — the tree to present (injectable for tests/fixtures).
 * @returns the model rendered by the game and the gym.
 */
export function buildHangarScreenModel(
  payload: HangarWarPayload,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): HangarScreenModel {
  const unlockRows = buildHangarUnlockRows(payload, catalogue);
  const hullOptions = buildHangarHullOptions(payload, catalogue);
  const weaponOptions = buildHangarWeaponOptions(payload, catalogue);
  const modifierOptions = buildHangarModifierOptions(payload, catalogue);
  const deployRow = buildHangarDeployRow(payload, catalogue);
  const focusOrder = [
    ...unlockRows.filter((row) => row.actionable),
    ...hullOptions.filter((row) => row.actionable),
    ...weaponOptions.filter((row) => row.actionable),
    ...modifierOptions.filter((row) => row.actionable),
    deployRow,
  ].map((row) => row.key);
  return {
    title: HANGAR_SCREEN_TITLE,
    salvageLine: formatSalvageLine(payload),
    ringLine: formatRingLine(payload.ring),
    unlockRows,
    hullOptions,
    weaponOptions,
    modifierOptions,
    deployRow,
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

/**
 * Buys one catalogue entry and returns the updated payload (pure).
 *
 * Delegates every rule to the economy's `buy`; the caller persists the result
 * through the hangar-war store.
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
  const result = buy(payload.hangar, entry, {
    ringIndex: payload.ring.ringIndex,
  });
  const next = clonePayload(payload);
  next.hangar = result.hangar;
  return { ok: result.ok, reason: result.reason, payload: next };
}

/**
 * Equips an owned hull and returns the updated payload (pure).
 *
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

/**
 * Toggles one owned starting weapon in the active loadout (pure).
 *
 * Removing the last equipped weapon is refused (the fleet always deploys
 * armed), so the result reports `ok: false` and the payload is unchanged.
 */
export function toggleHangarWeapon(
  payload: HangarWarPayload,
  weaponId: string,
): HangarUpdateResult {
  const current = resolveActiveLoadout(payload.hangar).startingWeapons;
  const equipped = current.includes(weaponId);
  if (equipped && current.length <= 1) {
    return { ok: false, reason: null, payload: clonePayload(payload) };
  }
  const requested = equipped
    ? current.filter((id) => id !== weaponId)
    : [...current, weaponId];
  const next = clonePayload(payload);
  next.hangar = equipLoadout(payload.hangar, {
    startingWeapons: requested,
    modifiers: payload.hangar.activeLoadout.modifiers,
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
  });
  const applied = resolveActiveLoadout(next.hangar).modifiers;
  return {
    ok: equipped ? !applied.includes(modifierId) : applied.includes(modifierId),
    reason: null,
    payload: next,
  };
}

/** Optional rendering knobs for {@link renderHangarScreen}. */
export interface HangarScreenRenderOptions {
  /** Bottom hint line (defaults to {@link HANGAR_SCREEN_HINT}). */
  readonly hint?: string;
}

/** The actions a rendered hangar screen invokes. */
export interface HangarScreenHandlers {
  /** Buy an unlock (`BUY` rows only). */
  onBuy(entryId: string): void;
  /** Equip an owned hull. */
  onEquipHull(hullId: string): void;
  /** Toggle an owned starting weapon in the loadout. */
  onToggleWeapon(weaponId: string): void;
  /** Toggle an owned permanent modifier on the loadout. */
  onToggleModifier(modifierId: string): void;
  /** Launch a deployment at `hexId` (the ▶ DEPLOY row). */
  onDeploy(hexId: string | null): void;
}

/** One rendered row, exposed for tests and screen queries. */
export interface HangarScreenRow {
  /** Row key (matches {@link HangarScreenModel.focusOrder}). */
  key: string;
  /** Rendered text. */
  label: string;
  /** Whether the row can be activated. */
  actionable: boolean;
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
  /** Destroys the rendered objects and detaches the keyboard listener. */
  destroy(): void;
}

/** Neon colours reused across rows (GDD §7.1). */
const ROW_COLOR = '#00ff88';
const DISABLED_COLOR = '#555555';
const HEADING_COLOR = '#00ffff';
const TEXT_COLOR = '#88ffff';

/** Layout constants (single-source so the game and the gym match). */
const LEFT_X = 60;
const RIGHT_X = 520;
const TITLE_Y = 34;
const SALVAGE_Y = 70;
const RING_Y = 90;
const SECTION_Y = 118;
const ROW_START_Y = 144;
const ROW_STEP = 21;

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

/** Renders one row and returns its text object. */
function rowText(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.Text[],
  x: number,
  y: number,
  label: string,
  actionable: boolean,
): Phaser.GameObjects.Text {
  const text = scene.add.text(x, y, label, {
    fontFamily: 'monospace',
    fontSize: '13px',
    color: actionable ? ROW_COLOR : DISABLED_COLOR,
  });
  objects.push(text);
  return text;
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

  const addRow = (
    x: number,
    y: number,
    key: string,
    label: string,
    actionable: boolean,
    action: (() => void) | undefined,
  ): void => {
    // A row is only *activatable* when the economy says it is AND this render
    // supplied a handler for it. A read-only render (the gym, a preview) shows
    // the same state and colours but can activate nothing, so its rows report
    // `actionable: false` and never enter the focus cycle.
    const interactive = actionable && action !== undefined;
    const text = rowText(scene, objects, x, y, label, actionable);
    const row: HangarScreenRow = { key, label, actionable: interactive, text };
    rendered.rows.push(row);
    rendered.byKey.set(key, row);
    if (!interactive || !action) return;
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setStyle({ color: '#ffffff' }));
    text.on('pointerout', () => text.setStyle({ color: ROW_COLOR }));
    text.on('pointerdown', () => action());
    focusManager.register(text, action);
  };

  // ── Unlock tree (left column) ──────────────────────────────────
  heading(scene, objects, LEFT_X, SECTION_Y, 'UNLOCKS');
  model.unlockRows.forEach((row, index) => {
    addRow(
      LEFT_X,
      ROW_START_Y + index * ROW_STEP,
      row.key,
      row.label,
      row.actionable,
      handlers?.onBuy ? () => handlers.onBuy!(row.id) : undefined,
    );
  });

  // ── Deployment selector (right column) ─────────────────────────
  heading(scene, objects, RIGHT_X, SECTION_Y, 'HULLS');
  model.hullOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      ROW_START_Y + index * ROW_STEP,
      option.key,
      option.label,
      option.actionable,
      handlers?.onEquipHull
        ? () => handlers.onEquipHull!(option.id)
        : undefined,
    );
  });

  const loadoutHeadingY =
    ROW_START_Y + model.hullOptions.length * ROW_STEP + 10;
  heading(scene, objects, RIGHT_X, loadoutHeadingY, 'LOADOUT');
  model.weaponOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      loadoutHeadingY + 26 + index * ROW_STEP,
      option.key,
      option.label,
      option.actionable,
      handlers?.onToggleWeapon
        ? () => handlers.onToggleWeapon!(option.id)
        : undefined,
    );
  });

  const modifierHeadingY =
    loadoutHeadingY + 26 + model.weaponOptions.length * ROW_STEP + 10;
  heading(scene, objects, RIGHT_X, modifierHeadingY, 'MODIFIERS');
  model.modifierOptions.forEach((option, index) => {
    addRow(
      RIGHT_X,
      modifierHeadingY + 26 + index * ROW_STEP,
      option.key,
      option.label,
      option.actionable,
      handlers?.onToggleModifier
        ? () => handlers.onToggleModifier!(option.id)
        : undefined,
    );
  });

  // ── Deploy (bottom, the screen's primary action) ─────────────
  addRow(
    LEFT_X,
    GAME_HEIGHT - 52,
    model.deployRow.key,
    model.deployRow.label,
    model.deployRow.actionable,
    handlers?.onDeploy
      ? () => handlers.onDeploy!(model.deployRow.hexId)
      : undefined,
  );

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 14, options?.hint ?? HANGAR_SCREEN_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#555555',
      })
      .setOrigin(0.5, 1),
  );

  focusManager.attachKeyboard(scene);

  const focusedKey = (): string | null => {
    const index = focusManager.getFocusedIndex();
    if (index < 0) return null;
    const focusable = rendered.rows.filter((row) => row.actionable);
    return focusable[index]?.key ?? null;
  };

  return {
    model,
    rows: rendered.rows,
    getFocusedKey: focusedKey,
    focusRow(key: string): boolean {
      const focusable = rendered.rows.filter((row) => row.actionable);
      const index = focusable.findIndex((row) => row.key === key);
      if (index < 0) return false;
      focusManager.setFocusedIndex(index);
      return true;
    },
    activateFocused(): void {
      focusManager.activateFocused();
    },
    destroy(): void {
      focusManager.shutdown();
      for (const object of rendered.objects) object.destroy();
      rendered.objects.length = 0;
      rendered.rows.length = 0;
      rendered.byKey.clear();
    },
  };
}

/** The starting weapon a hangar always keeps when a loadout is emptied. */
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
