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
 * The ▶ DEPLOY row (AH-0MVUXC2DD003HN0I) launches the **normal run** through
 * this scene's one deployment path: {@link deploy} builds the pure deployment
 * payload (`./hangarDeployment` — the hangar-resolved hull/loadout and the
 * target hex's aggression-selected difficulty) and starts the shipped
 * `PlayScene` with it. It never touches the arcade checkpoint: a hex
 * deployment is a separate session that neither clears nor overwrites the
 * arcade save.
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
import {
  decideHangarAction,
  HANGAR_WAR_TRAVERSAL_DWELL_MS,
  HANGAR_WAR_TRAVERSAL_MAX_ACTIONS,
} from '../ai/hangarWarTraversal';
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
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

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
  /**
   * Bot-driven attract traversal (AH-0MVUXCBBK004EJIP): the pure
   * `decideHangarAction` buys the cheapest useful unlock (seeded tie-break) and
   * then deploys, so the demo never stalls in the hangar.
   */
  demo?: boolean;
  /** Demo dwell override in milliseconds (tests use a short one). */
  demoDwellMs?: number;
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

  /** Whether the attract traversal is driving this screen. */
  private demo = false;

  /** Demo dwell override (production uses the shared traversal dwell). */
  private demoDwellMs?: number;

  /** The demo action timer, cleared on shutdown. */
  private demoTimer: Phaser.Time.TimerEvent | null = null;

  /** Demo actions applied so far (bounded by the shared safety cap). */
  private demoActions = 0;

  constructor() {
    super(HANGAR_SCENE_KEY);
  }

  init(data?: HangarSceneData | null): void {
    this.storage = data?.storage;
    this.catalogue = data?.catalogue ?? HANGAR_CATALOGUE;
    this.demo = data?.demo === true;
    this.demoDwellMs = data?.demoDwellMs;
    this.demoActions = 0;
    const injected = data?.payload;
    this.payload = injected ?? this.loadPayload();
  }

  create(): void {
    this.build();
    addBackToMenuOnEsc(this);
    if (this.demo) this.scheduleDemoAdvance();
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
    // A demo run is a demonstration, not progress: it never overwrites the
    // player's war (the same rule that keeps a demo off the leaderboard).
    if (this.demo) return;
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
      onDeploy: (hexId) => this.deploy(hexId),
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

  /**
   * Launches a deployment of the current loadout (AH-0MVUXC2DD003HN0I).
   *
   * Builds the pure deployment payload and starts the shipped `PlayScene`
   * with it — the same run code as Play Game, with only the hangar loadout and
   * the hex-aggression difficulty as inputs. The arcade checkpoint is neither
   * cleared nor written by this path.
   *
   * @param hexId — the hex to attack (defaults to the weakest unheld hex).
   * @returns the deployment payload that was launched (test seam).
   */
  deploy(hexId?: string | null): HangarWarDeployment {
    const deployment = buildHangarDeployment(this.payload, {
      hexId: hexId ?? null,
      catalogue: this.catalogue,
    });
    this.scene.start('PlayScene', {
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
      resume: false,
      hangarWar: deployment,
    });
    return deployment;
  }

  /**
   * Schedules the attract traversal's next step in the hangar.
   *
   * The decision is the pure, tested `decideHangarAction` (the cheapest useful
   * unlock with a seeded tie-break, then the deployment), so the scene owns no
   * shopping rule. Buying rebuilds the screen and reschedules; the catalogue is
   * finite and every purchase is bounded by
   * {@link HANGAR_WAR_TRAVERSAL_MAX_ACTIONS}, so the bot always reaches the
   * deployment.
   */
  private scheduleDemoAdvance(): void {
    this.demoTimer?.remove(false);
    const dwell = this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS;
    this.demoTimer = this.time.delayedCall(dwell, () => {
      if (!this.sys.isActive()) return;
      if (this.demoActions >= HANGAR_WAR_TRAVERSAL_MAX_ACTIONS) {
        // Safety bound reached (a refused purchase loop): deploy and leave.
        this.deploy();
        return;
      }
      this.demoActions += 1;
      const action = decideHangarAction(this.payload, {
        catalogue: this.catalogue,
      });
      if (action.kind === 'buy') {
        this.buy(action.entryId);
        this.scheduleDemoAdvance();
        return;
      }
      this.deploy();
    });
  }

  /** Whether the attract traversal is driving this screen (test seam). */
  isDemo(): boolean {
    return this.demo;
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
