/**
 * Hangar scene — the player-facing hangar screen of the Hangar War
 * (AH-0MVUXC1X6007KAG1, part of **Build Candidate D — Hangar War**).
 *
 * The screen sits one click from the hex map: it shows banked salvage, the
 * unlock tree (cost, owned, gated), and the deployment selector (which hull
 * and which starting weapons the next deployment carries). Design of record:
 * `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene surface.
 *
 * **All state goes through the hangar-war store and the pure economy module.**
 * The scene renders {@link buildHangarScreenModel} through the shared
 * {@link renderHangarScreen} (the same renderer `GymHangar` uses read-only) and
 * applies every change with a pure updater from `./hangarScreen`
 * ({@link purchaseHangarEntry}, {@link equipHangarHull},
 * {@link toggleHangarWeapon}, {@link toggleHangarModifier}); it then persists
 * the payload through `hangarWarStore.saveHangarWarPayload`. No purchase rule,
 * price or loadout decision lives in this file.
 *
 * Navigation follows the shipped scene conventions: the shared `FocusManager`
 * (Tab / arrows cycle, Enter/Space activate) plus pointer handlers, ESC back
 * to the main menu. Disabled rows (owned, gated, unaffordable, last equipped
 * weapon) are muted and are neither interactive nor focusable.
 *
 * The payload can be injected as launch data (`{ payload, storage }`) so tests
 * (and later the attract traversal) boot a deterministic war without touching
 * `localStorage`; production callers pass nothing and the versioned store is
 * used.
 *
 * @module src/scenes/HangarScene
 */

import Phaser from 'phaser';

import { createDefaultPayload, loadHangarWarPayload, saveHangarWarPayload } from '../core/hangarWar/hangarWarStore';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import {
  HANGAR_CATALOGUE,
  type HangarEntry,
} from '../data/hangarCatalogue';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import {
  buildHangarScreenModel,
  equipHangarHull,
  purchaseHangarEntry,
  renderHangarScreen,
  toggleHangarModifier,
  toggleHangarWeapon,
  type HangarScreenModel,
  type HangarScreenRow,
  type HangarScreenView,
} from './hangarWar/hangarScreen';

/** Scene key (matches the class name, per the scene convention). */
export const HANGAR_SCENE_KEY = 'HangarScene';

/** Launch data accepted by {@link HangarScene}. */
export interface HangarSceneData {
  /**
   * Payload to show instead of the stored one (tests, gym-style fixtures and
   * the attract traversal). Defaults to the versioned store's payload.
   */
  payload?: HangarWarPayload;
  /**
   * Storage adapter for persistence. Omitted → the store's `localStorage`
   * adapter; `null` → in-memory only (a test that must not touch storage).
   */
  storage?: HangarWarStorage | null;
  /** Unlock tree to render (defaults to the shipped catalogue). */
  catalogue?: readonly HangarEntry[];
}

/**
 * The hangar screen.
 */
export class HangarScene extends Phaser.Scene {
  /** The payload currently shown (a detached copy of injected data). */
  private payload: HangarWarPayload = createDefaultPayload(0);

  /** Injected storage adapter, or `undefined` for the store's default. */
  private storage: HangarWarStorage | null | undefined;

  /** The unlock tree in use (shipped catalogue unless injected). */
  private catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE;

  /** The rendered screen (rebuilt after every change). */
  private view: HangarScreenView | null = null;

  /** Row key to restore focus to after a rebuild, or `null`. */
  private pendingFocusKey: string | null = null;

  constructor() {
    super(HANGAR_SCENE_KEY);
  }

  init(data?: HangarSceneData | null): void {
    this.storage = data?.storage;
    this.catalogue = data?.catalogue ?? HANGAR_CATALOGUE;
    const injected = data?.payload;
    this.payload = injected ?? this.loadPayload();
  }

  create(): void {
    this.build();
    addBackToMenuOnEsc(this);
  }

  /** Loads the stored payload, or a fresh default war when there is none. */
  private loadPayload(): HangarWarPayload {
    const stored =
      this.storage === undefined
        ? loadHangarWarPayload()
        : loadHangarWarPayload(this.storage);
    return stored ?? createDefaultPayload(0);
  }

  /** Persists the current payload through the versioned store. */
  private persist(): void {
    if (this.storage === undefined) {
      saveHangarWarPayload(this.payload);
    } else {
      saveHangarWarPayload(this.payload, this.storage);
    }
  }

  /**
   * (Re)renders the screen from the current payload, restoring focus to
   * `pendingFocusKey` when that row survived the change.
   */
  private build(): void {
    this.view?.destroy();
    const model = buildHangarScreenModel(this.payload, this.catalogue);
    this.view = renderHangarScreen(this, model, {
      onBuy: (entryId) => this.buy(entryId),
      onEquipHull: (hullId) => this.equipHull(hullId),
      onToggleWeapon: (weaponId) => this.toggleWeapon(weaponId),
      onToggleModifier: (modifierId) => this.toggleModifier(modifierId),
    });
    const key = this.pendingFocusKey;
    this.pendingFocusKey = null;
    if (key !== null) this.view.focusRow(key);
  }

  /** Rebuilds and keeps focus on `key` when it is still actionable. */
  private rebuildKeepingFocus(key: string): void {
    this.pendingFocusKey = key;
    this.build();
  }

  /**
   * Buys one unlock and persists the result. A refused purchase (owned, gated
   * or unaffordable) leaves the payload unchanged, so a stale UI can never
   * spend salvage the economy did not authorise.
   */
  buy(entryId: string): boolean {
    const result = purchaseHangarEntry(this.payload, entryId, this.catalogue);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`buy:${entryId}`);
    return result.ok;
  }

  /** Equips an owned hull and persists it (no-op for an unowned hull). */
  equipHull(hullId: string): boolean {
    const result = equipHangarHull(this.payload, hullId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`hull:${hullId}`);
    return result.ok;
  }

  /** Toggles an owned starting weapon in the loadout and persists it. */
  toggleWeapon(weaponId: string): boolean {
    const result = toggleHangarWeapon(this.payload, weaponId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`weapon:${weaponId}`);
    return result.ok;
  }

  /** Toggles an owned permanent modifier on the loadout and persists it. */
  toggleModifier(modifierId: string): boolean {
    const result = toggleHangarModifier(this.payload, modifierId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`modifier:${modifierId}`);
    return result.ok;
  }

  // ── Public query seams (keyboard/pointer tests use these) ───────

  /** The payload currently shown (a detached copy of any injected data). */
  getPayload(): HangarWarPayload {
    return this.payload;
  }

  /** The rendered screen model. */
  getModel(): HangarScreenModel {
    return this.view?.model ?? buildHangarScreenModel(this.payload, this.catalogue);
  }

  /** Every rendered row, in reading order. */
  getRows(): readonly HangarScreenRow[] {
    return this.view?.rows ?? [];
  }

  /** The focused row key, or `null` when no row is focusable. */
  getFocusedKey(): string | null {
    return this.view?.getFocusedKey() ?? null;
  }

  /** Moves focus to `key` when it is actionable (deterministic test seam). */
  focusRow(key: string): boolean {
    return this.view?.focusRow(key) ?? false;
  }

  /** Activates the focused row (the Enter/Space path). */
  activateFocused(): void {
    this.view?.activateFocused();
  }
}
