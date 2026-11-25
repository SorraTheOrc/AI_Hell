/**
 * Hangar scene — the player-facing hangar screen of the Hangar War
 * (AH-0MVUXC1X6007KAG1, part of **Build Candidate D — Hangar War**).
 *
 * The screen sits one click from the hex map: the `⌗ HEX MAP` row opens
 * `HexMapScene` with this hangar's payload, the mirror of the map's own
 * `◀ HANGAR` row. It shows banked salvage, the unlock tree (cost, owned, gated),
 * and the deployment selector (which hull and which starting weapons the next
 * deployment carries). Design of record:
 * `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene surface.
 *
 * **All state goes through the hangar-war store and the pure economy module.**
 * The scene renders {@link buildHangarScreenModel} through the shared
 * {@link renderHangarScreen} (the same renderer `GymHangar` uses read-only) and
 * applies every change with a pure updater from `./hangarScreen`
 * ({@link purchaseHangarEntry}, {@link upgradeHangarKind},
 * {@link equipHangarHull}, {@link toggleHangarWeapon},
 * {@link toggleHangarPowerUp}, {@link toggleHangarModifier}); it then persists
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
 * arcade save. The hex is the one carried from the map
 * (`HangarSceneData.targetHexId`) — the same hex the intel names — and a menu
 * entry with no carried hex keeps the shipped weakest-unheld default
 * (AH-0MWMT4RJC0095L4O).
 *
 * ## The map's config step (AH-0MWMT4S5U001EGDF)
 *
 * A hex activation on the map opens **this** screen pre-targeted at the hex
 * (`HexMapScene.openConfig`) instead of starting `PlayScene`, so no hex battle
 * begins without the config screen first (parent AH-0MWMRWCY2001HWGR AC1). The
 * `▶ DEPLOY` row is the only launch: it names the carried hex and deploys there.
 * The map's `◀ HANGAR` row carries no target, so a menu-style entry keeps the
 * shipped default. This screen's own bounded demo advance (`decideHangarAction`)
 * deploys at the carried target, which is what makes the attract traversal walk
 * `map → config → deployment` without stalling.
 *
 * ## Target intel is display only (AH-0MWMT4STK001PSK4)
 *
 * The screen publishes its target hex's authored boss intel as a `TARGET INTEL`
 * block and marks every weapon row `▲ EFFECTIVE` / `▼ RESISTED` against that
 * boss. Both come from the shared model builder (`buildHangarBossIntel` over
 * the authored ring data, plus the pure `resolveBossMatchup`,
 * `src/core/hangarWar/weaponMatchup.ts`) and are **display only**: they change
 * nothing about the fight. The mechanical matchup is
 * AH-0MWL5376H001WJFZ's `resolveHexMatchup`, never a second rule here, and
 * `GymHangar` renders the identical intel and marks read-only from the same
 * model (AGENTS.md gym↔game parity).
 *
 * The `⟲ RESTART WAR` row (AH-0MW8F7NH1002PQE3) returns the war to its
 * documented starting position behind a two-step confirm. The scene owns the
 * arming bit and its 5 s timer (the screen is rebuilt on every change, so the
 * row cannot hold them); the pure `advanceRestartConfirm` decides arm/confirm/
 * disarm and `restartHangarWar` builds the fresh payload, which is persisted
 * through the same store. A focus move to another row, leaving the screen or
 * the window expiring disarms it, so a stray Enter can only ever arm the
 * control. Under `demo` the row is rendered non-actionable and nothing is
 * written — a demo is not progress.
 *
 * ## Auto-fit on open and the apply-suggested-buildout row
 * (AH-0MWOWEPO2004B0MR, parent AH-0MWOROJYT004WPSD)
 *
 * Opening the screen **auto-fits** the boss-aware suggestion when the loadout
 * is at its shipped default — exactly an empty `activeLoadout.startingWeapons`
 * (`isDefaultHangarLoadout`), never "the selector found no strong weapon". A
 * hand-picked loadout is therefore never silently rewritten; the
 * `⚡ APPLY SUGGESTED BUILDOUT` row is the one path that replaces it, for any
 * loadout, and both paths persist through the same single
 * `saveHangarWarPayload` write as every other change. The selection itself
 * (`selectAutoLoadout` via `applyAutoLoadout`) and the row (`buildoutRow`) live
 * in the shared model — this scene owns no selection rule. Under `demo` the row
 * is rendered non-actionable and never wired, and nothing is auto-fitted, so a
 * demonstration can never overwrite the war (matching the saved-build and
 * restart rows).
 *
 * The payload can be injected as launch data (`{ payload, storage }`) so tests
 * (and later the attract traversal) boot a deterministic war without touching
 * `localStorage`; production callers pass nothing and the versioned store is
 * used. The on-open auto-fit is the one exception to "an injected payload is
 * shown as given": it is derived purely from that payload, and it is persisted
 * only through the caller's store (`storage: null` keeps it in memory).
 *
 * @module src/scenes/HangarScene
 */

import Phaser from 'phaser';

import { materialiseRing } from '../core/hangarWar/captureCycle';
import { createDefaultPayload, loadHangarWarPayload, saveHangarWarPayload } from '../core/hangarWar/hangarWarStore';
import { randomSeed } from '../core/rng';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
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
  advanceNameEntry,
  advanceRestartConfirm,
  applyAutoLoadout,
  applyHangarBuild,
  BUILDOUT_ROW_KEY,
  buildHangarScreenModel,
  CYCLE_BUILD_ROW_KEY,
  deleteHangarBuild,
  equipHangarHull,
  isCommitableNameEntry,
  isDefaultHangarLoadout,
  purchaseHangarEntry,
  renderHangarScreen,
  renameHangarBuild,
  restartHangarWar,
  saveHangarBuild,
  savedBuildRowKey,
  SAVE_BUILD_ROW_KEY,
  toggleHangarModifier,
  toggleHangarPowerUp,
  toggleHangarWeapon,
  upgradeHangarKind,
  RESTART_CONFIRM_TIMEOUT_MS,
  RESTART_ROW_KEY,
  type HangarScreenHandlers,
  type HangarScreenModel,
  type HangarScreenRow,
  type HangarScreenView,
} from './hangarWar/hangarScreen';
import { MAX_SAVED_BUILD_NAME_LENGTH } from '../core/hangarWar/hangarEconomy';
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
  /**
   * The hex the player chose on the map (transient launch data). The scene
   * carries it into the model — so the base intel and the `▶ DEPLOY` row name
   * that hex — and into {@link deploy} as the fallback target. Omitted/`null`
   * keeps the shipped default (the weakest unheld hex). Never persisted.
   */
  targetHexId?: string | null;
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

  /**
   * The hex this visit was launched for, or `null` for a menu entry
   * (AH-0MWMT4RJC0095L4O). Transient launch data only: `init` resets it on
   * every scene start, so a stale target can never leak between visits, and it
   * is never persisted.
   */
  private targetHexId: string | null = null;

  /**
   * Whether the `⟲ RESTART WAR` row is armed — the first step of the two-step
   * confirm has happened and the next activation wipes the war. The arming
   * state lives in the scene (not the row) because every change rebuilds the
   * screen, and the confirm window must survive that rebuild
   * (AH-0MW8F7NH1002PQE3).
   */
  private restartArmed = false;

  /** The pending confirm-window timer, cleared on disarm/shutdown. */
  private restartTimer: Phaser.Time.TimerEvent | null = null;

  /** The index of the currently selected saved build (the drop-down position). */
  private savedBuildIndex = 0;

  /** A transient saved-build message (an apply refusal's shortfall). */
  private savedBuildMessage: string | null = null;

  /** The active name-entry mode, or `null` when not naming a build. */
  private nameEntry: {
    mode: 'save' | 'rename';
    buildId: string | null;
    buffer: string;
  } | null = null;

  /** The text objects the name-entry overlay owns (destroyed on exit). */
  private nameEntryTexts: Phaser.GameObjects.Text[] = [];

  /** The keydown listener the name-entry overlay owns, removed on exit. */
  private nameEntryKeyHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor() {
    super(HANGAR_SCENE_KEY);
  }

  init(data?: HangarSceneData | null): void {
    this.storage = data?.storage;
    this.catalogue = data?.catalogue ?? HANGAR_CATALOGUE;
    this.demo = data?.demo === true;
    this.demoDwellMs = data?.demoDwellMs;
    this.demoActions = 0;
    // A fresh visit starts on the first saved build and with no transient
    // message or open name-entry overlay (AH-0MWL8C6FE008G1E7).
    this.savedBuildIndex = 0;
    this.savedBuildMessage = null;
    this.closeNameEntry(false);
    // `init` runs on every scene start: reset the carried target so a previous
    // visit's hex can never leak into a menu-entry visit.
    this.targetHexId = data?.targetHexId ?? null;
    const injected = data?.payload;
    if (injected !== undefined) {
      // An injected payload is a caller's fixture (tests, and the map handing
      // over its already-materialised war): it is shown as given and never
      // written back. Materialising a ring is a **persisted** state change, so
      // it belongs to the real load path below.
      this.payload = injected;
    } else {
      const loaded = this.loadPayload();
      // Materialise a fresh war's ring from the authored definitions — the same
      // rule `HexMapScene.init()` applies to a stored war — so `▶ DEPLOY` names
      // a real hex and the first battle runs the normal capture cycle that pays
      // its salvage and bonus (AH-0MWNGYDIZ0037HGW, producer Q2 = (a)). A
      // partial ring is never padded and an authored-empty ring is left as-is;
      // the demo and in-memory guards live in `persist()`.
      this.payload = materialiseRing(loaded, HEX_RING_DEFINITIONS);
      if (this.payload.ring.hexes.length > loaded.ring.hexes.length) {
        this.persist();
      }
    }
    // A fresh (default/empty) loadout is fitted against this visit's target
    // before the first model build, so the screen — and the deployment it
    // feeds — open with the boss-aware suggestion already equipped
    // (AH-0MWOWEPO2004B0MR).
    this.autoFitLoadout();
  }

  create(): void {
    this.build();
    addBackToMenuOnEsc(this);
    if (this.demo) this.scheduleDemoAdvance();
    // Leaving the screen disarms the restart confirm, so re-entering the
    // hangar can never inherit a half-armed confirm (AH-0MW8F7NH1002PQE3).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.disarmRestart();
      // Drop any open name-entry overlay's listener so it cannot outlive the scene.
      this.closeNameEntry(false);
    });
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
    const model = buildHangarScreenModel(this.payload, this.catalogue, {
      restartArmed: this.restartArmed,
      targetHexId: this.targetHexId,
      savedBuildIndex: this.savedBuildIndex,
      savedBuildMessage: this.savedBuildMessage,
    });
    const handlers: Partial<HangarScreenHandlers> = {
      onBuy: (entryId) => this.buy(entryId),
      onUpgrade: (kindId) => this.upgrade(kindId),
      onEquipHull: (hullId) => this.equipHull(hullId),
      onToggleWeapon: (weaponId) => this.toggleWeapon(weaponId),
      onTogglePowerUp: (powerUpId) => this.togglePowerUp(powerUpId),
      onToggleModifier: (modifierId) => this.toggleModifier(modifierId),
      onDeploy: (hexId) => this.deploy(hexId),
      onOpenMap: () => this.openMap(),
    };
    // A demo is a demonstration, not progress: the bot never selects the
    // restart row (its decision function gains no restart branch) and the row
    // is rendered non-actionable under `demo`, so it can neither reset the war
    // nor write to the store (the same rule that keeps a demo off the
    // leaderboard). AH-0MW8F7NH1002PQE3.
    if (!this.demo) handlers.onRestart = () => this.restart();
    // Saved-build and buildout actions are player actions: under `demo` they
    // are omitted so the rows render non-actionable and a demo can never
    // overwrite the war.
    if (!this.demo) {
      handlers.onApplyBuildout = () => this.applyBuildout();
      handlers.onSaveBuild = () => this.saveBuild();
      handlers.onCycleBuild = () => this.cycleBuild();
      handlers.onApplyBuild = (buildId) => this.applyBuild(buildId);
      handlers.onRenameBuild = (buildId) => this.renameBuild(buildId);
      handlers.onDeleteBuild = (buildId) => this.deleteBuild(buildId);
    }
    this.view = renderHangarScreen(this, model, handlers, {
      onFocusChange: (key) => this.onRowFocusChange(key),
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
    this.disarmRestart();
    const result = purchaseHangarEntry(this.payload, entryId, this.catalogue);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`buy:${entryId}`);
    return result.ok;
  }

  /**
   * Buys the next permanent level of an owned weapon and persists the result
   * (parent AH-0MWHW4ALS0039JFU AC3, this item AH-0MWI5AK1E008HDHH).
   *
   * The row's `UPGRADE` action: every rule (price, cap, affordability, the
   * raised level) comes from the pure economy through
   * `hangarWarStore.buyHangarUpgrade`, so the screen owns no purchase logic. A
   * refused upgrade spends nothing and changes no level, and the raised level
   * is persisted through the same `saveHangarWarPayload` call as the spend, so
   * the two can never land separately.
   *
   * @param kindId — the owned weapon id to upgrade.
   * @returns true when the level was bought and persisted.
   */
  upgrade(kindId: string): boolean {
    this.disarmRestart();
    const result = upgradeHangarKind(this.payload, kindId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    // The row key is stable (`buy:<id>`), so focus stays on the row the player
    // just bought from instead of jumping to the top of the tree.
    this.rebuildKeepingFocus(`buy:${kindId}`);
    return result.ok;
  }

  /** Equips an owned hull and persists it (no-op for an unowned hull). */
  equipHull(hullId: string): boolean {
    this.disarmRestart();
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
    this.disarmRestart();
    const result = toggleHangarWeapon(this.payload, weaponId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`weapon:${weaponId}`);
    return result.ok;
  }

  /**
   * Toggles an owned level-bearing power-up in the deployment selection and
   * persists it (the `POWER-UP` rows, beside the weapons). The selection is
   * read through the shared economy rule, so the first toggle on an un-curated
   * save starts from every owned power-up and writes an explicit list.
   */
  togglePowerUp(powerUpId: string): boolean {
    this.disarmRestart();
    const result = toggleHangarPowerUp(this.payload, powerUpId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`power-up:${powerUpId}`);
    return result.ok;
  }

  /**
   * Auto-fits the published suggestion on open, only for a default/empty
   * loadout (AH-0MWOWEPO2004B0MR, parent AH-0MWOROJYT004WPSD AC4).
   *
   * A hand-picked (non-empty) loadout is never rewritten: it is preserved until
   * the player activates the `⚡ APPLY SUGGESTED BUILDOUT` row. The fit uses the
   * model's published `bossIntel` (one target resolution, shared with the intel
   * block and `▶ DEPLOY`) and persists through the same single store write as
   * every other change; an unchanged fit (the selector's fixed point) writes
   * nothing. Under `demo` nothing is fitted and nothing is written.
   */
  private autoFitLoadout(): void {
    // A demo is a demonstration, not the player's war.
    if (this.demo) return;
    if (!isDefaultHangarLoadout(this.payload)) return;
    const model = buildHangarScreenModel(this.payload, this.catalogue, {
      targetHexId: this.targetHexId,
    });
    const result = applyAutoLoadout(
      this.payload,
      this.catalogue,
      model.bossIntel,
    );
    if (!result.changed) return;
    this.payload = result.payload;
    this.persist();
  }

  /**
   * Handles the `⚡ APPLY SUGGESTED BUILDOUT` row: equips the model's published
   * suggestion — a full replacement, the one explicit path that overwrites a
   * hand-picked loadout — persists it and keeps focus on the row
   * (AH-0MWOWEPO2004B0MR).
   *
   * @returns true when the loadout changed (and was persisted).
   */
  applyBuildout(): boolean {
    // Belt and braces: under `demo` the row is never wired.
    if (this.demo) return false;
    this.disarmRestart();
    const model = this.getModel();
    const result = applyAutoLoadout(
      this.payload,
      this.catalogue,
      model.bossIntel,
    );
    if (result.changed) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(BUILDOUT_ROW_KEY);
    return result.changed;
  }

  /** Toggles an owned permanent modifier on the loadout and persists it. */
  toggleModifier(modifierId: string): boolean {
    this.disarmRestart();
    const result = toggleHangarModifier(this.payload, modifierId);
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(`modifier:${modifierId}`);
    return result.ok;
  }

  /**
   * Handles the `⟲ RESTART WAR` row (AH-0MW8F7NH1002PQE3).
   *
   * The first activation only **arms** the row (`⚠ PRESS AGAIN TO CONFIRM`)
   * and starts the confirm window; a second activation inside that window
   * commits the reset. The arming state and timer live on the scene (they
   * must survive the rebuild every change triggers). Under `demo` the row is
   * never wired, so this method is unreachable — the guard is belt and braces.
   *
   * @returns true when the war was reset (the second activation).
   */
  restart(): boolean {
    // A demo is a demonstration, not progress: it never resets the war.
    if (this.demo) return false;
    const transition = advanceRestartConfirm(this.restartArmed, {
      kind: 'activate',
    });
    if (transition.reset) {
      // Second activation inside the window: wipe the war to its starting
      // position with a fresh seed, keeping the all-time best score.
      this.disarmRestart();
      // A restarted war is a fresh war: materialise its ring from the authored
      // definitions so the new war's first `▶ DEPLOY` also names a real hex and
      // pays through the normal capture cycle (AH-0MWNGYDIZ0037HGW).
      this.payload = materialiseRing(
        restartHangarWar(this.payload, randomSeed()),
        HEX_RING_DEFINITIONS,
      );
      this.persist();
      this.rebuildKeepingFocus(RESTART_ROW_KEY);
      return true;
    }
    // First activation: arm and start the confirm window.
    this.restartArmed = true;
    this.startRestartTimer();
    this.rebuildKeepingFocus(RESTART_ROW_KEY);
    return false;
  }

  // ── Saved ship configurations (AH-0MWL8C6FE008G1E7) ───────────────────

  /** The saved builds currently in the payload (empty when none). */
  private savedBuilds() {
    return this.payload.hangar.savedBuilds ?? [];
  }

  /** Clamps the selected saved-build index into the current list. */
  private clampSavedBuildIndex(): void {
    const count = this.savedBuilds().length;
    if (count === 0) {
      this.savedBuildIndex = 0;
    } else if (this.savedBuildIndex >= count) {
      this.savedBuildIndex = count - 1;
    } else if (this.savedBuildIndex < 0) {
      this.savedBuildIndex = 0;
    }
  }

  /** The currently selected saved build, or `null` when there is none. */
  /** Formats a refused build's exact shortfall for the transient message line. */
  private formatShortfall(name: string, shortfall: { entries: readonly { id: string }[]; minerals: number; cores: number }, reason: string): string {
    const parts: string[] = [];
    if (shortfall.minerals > 0) parts.push(`${shortfall.minerals} more minerals`);
    if (shortfall.cores > 0) parts.push(`${shortfall.cores} more cores`);
    const entryIds = shortfall.entries.map((entry) => entry.id);
    if (entryIds.length > 0) parts.push(`missing ${entryIds.join(', ')}`);
    const detail = parts.length > 0 ? ` — ${parts.join(', ')}` : '';
    return reason === 'unaffordable'
      ? `Cannot afford “${name}”${detail}`
      : `Cannot apply “${name}” (${reason})${detail}`;
  }

  /** Opens the name-entry overlay prefilled from the current configuration. */
  private openNameEntry(mode: 'save' | 'rename', buildId: string | null, initial: string): void {
    this.disarmRestart();
    this.nameEntry = {
      mode,
      buildId,
      buffer: initial.slice(0, MAX_SAVED_BUILD_NAME_LENGTH),
    };
    // Tear down the rendered screen so the shared FocusManager cannot consume
    // Enter/Space while the player is typing a name (AH-0MWLE95BV000MWGF).
    this.view?.destroy();
    this.view = null;
    this.renderNameEntry();
    if (!this.nameEntryKeyHandler) {
      this.nameEntryKeyHandler = (event: KeyboardEvent) =>
        this.handleNameEntryKey(event);
      this.input.keyboard?.on('keydown', this.nameEntryKeyHandler);
    }
  }

  /** Renders (or re-renders) the name-entry overlay prompt and buffer. */
  private renderNameEntry(): void {
    for (const text of this.nameEntryTexts) text.destroy();
    this.nameEntryTexts = [];
    const entry = this.nameEntry;
    if (!entry) return;
    const prompt = entry.mode === 'save' ? 'SAVE BUILD — NAME' : 'RENAME BUILD — NAME';
    this.nameEntryTexts.push(
      this.add.text(60, 120, prompt, { fontFamily: 'monospace', fontSize: '18px', color: '#ffffff' }),
      this.add.text(60, 150, `> ${entry.buffer}_`, { fontFamily: 'monospace', fontSize: '18px', color: '#88ff88' }),
      this.add.text(60, 190, 'type a name · backspace deletes · enter saves · esc cancels', { fontFamily: 'monospace', fontSize: '12px', color: '#888888' }),
    );
  }

  /** Feeds one key to the name-entry buffer. */
  private handleNameEntryKey(event: KeyboardEvent): void {
    const entry = this.nameEntry;
    if (!entry) return;
    if (event.key === 'Enter') {
      this.commitNameEntry();
      return;
    }
    if (event.key === 'Escape') {
      this.closeNameEntry();
      return;
    }
    const next = advanceNameEntry(entry.buffer, event.key);
    if (next !== entry.buffer) {
      entry.buffer = next;
      this.renderNameEntry();
    }
  }

  /** Commits the open name entry (save or rename) and persists it. */
  private commitNameEntry(): void {
    const entry = this.nameEntry;
    if (!entry) return;
    if (!isCommitableNameEntry(entry.buffer)) {
      this.closeNameEntry();
      return;
    }
    const name = entry.buffer.trim();
    if (entry.mode === 'save') {
      const id = `build-${randomSeed()}`;
      this.payload = saveHangarBuild(this.payload, id, name);
      this.clampSavedBuildIndex();
      this.savedBuildMessage = `Saved build “${name}”`;
    } else if (entry.buildId !== null) {
      this.payload = renameHangarBuild(this.payload, entry.buildId, name);
      this.savedBuildMessage = `Renamed build to “${name}”`;
    }
    this.persist();
    this.closeNameEntry();
  }

  /** Closes the name-entry overlay and rebuilds the screen (optionally). */
  private closeNameEntry(rebuild = true): void {
    if (this.nameEntryKeyHandler) {
      this.input.keyboard?.off('keydown', this.nameEntryKeyHandler);
      this.nameEntryKeyHandler = null;
    }
    for (const text of this.nameEntryTexts) text.destroy();
    this.nameEntryTexts = [];
    this.nameEntry = null;
    if (rebuild && this.scene.isActive()) this.build();
  }

  /** Handles the `＋ SAVE CURRENT BUILD` row. */
  saveBuild(): void {
    if (this.demo) return;
    const hullId = this.payload.hangar.activeHull;
    const hull = this.catalogue.find((entry) => entry.id === hullId);
    this.openNameEntry('save', null, hull?.name ?? 'MY BUILD');
  }

  /** Handles the `◀ ▶ SAVED BUILD` cycle row (advances the selected index). */
  cycleBuild(): boolean {
    const count = this.savedBuilds().length;
    if (count === 0) return false;
    this.savedBuildIndex = (this.savedBuildIndex + 1) % count;
    this.rebuildKeepingFocus(CYCLE_BUILD_ROW_KEY);
    return true;
  }

  /** Handles the `▶ FLY` row: atomically applies the selected saved build. */
  applyBuild(buildId: string): boolean {
    if (this.demo) return false;
    this.disarmRestart();
    const build = this.savedBuilds().find((candidate) => candidate.id === buildId);
    const result = applyHangarBuild(this.payload, buildId);
    this.savedBuildMessage = result.ok
      ? `Applied build “${build?.name ?? buildId}”`
      : this.formatShortfall(
          build?.name ?? buildId,
          result.shortfall,
          result.reason ?? 'unknown',
        );
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
    }
    this.rebuildKeepingFocus(savedBuildRowKey('apply'));
    return result.ok;
  }

  /** Handles the `✎ RENAME` row: opens the name entry prefilled. */
  renameBuild(buildId: string): void {
    if (this.demo) return;
    const build = this.savedBuilds().find((candidate) => candidate.id === buildId);
    if (!build) return;
    this.openNameEntry('rename', buildId, build.name);
  }

  /** Handles the `✖ DELETE` row: removes the selected saved build. */
  deleteBuild(buildId: string): boolean {
    if (this.demo) return false;
    this.disarmRestart();
    const build = this.savedBuilds().find((candidate) => candidate.id === buildId);
    this.payload = deleteHangarBuild(this.payload, buildId);
    this.clampSavedBuildIndex();
    this.savedBuildMessage = build ? `Deleted build “${build.name}”` : null;
    this.persist();
    this.rebuildKeepingFocus(SAVE_BUILD_ROW_KEY);
    return true;
  }

  /** Starts (or restarts) the confirm window timer for the armed restart row. */
  private startRestartTimer(): void {
    this.clearRestartTimer();
    this.restartTimer = this.time.delayedCall(RESTART_CONFIRM_TIMEOUT_MS, () => {
      this.restartTimer = null;
      if (!this.restartArmed) return;
      // The confirm window expired: revert to the idle label.
      this.restartArmed = false;
      this.rebuildKeepingFocus(RESTART_ROW_KEY);
    });
  }

  /** Removes the pending confirm-window timer (safe when none is armed). */
  private clearRestartTimer(): void {
    this.restartTimer?.remove(false);
    this.restartTimer = null;
  }

  /** Clears the armed bit and its timer (a focus move, an abort or an exit). */
  private disarmRestart(): void {
    this.clearRestartTimer();
    this.restartArmed = false;
  }

  /**
   * Keeps the two-step confirm honest when focus moves: focusing any row other
   * than the restart row disarms it (a stray Enter can then only re-arm it).
   * The rebuild keeps the newly focused row, so navigation does not jump back
   * to the top of the screen.
   */
  private onRowFocusChange(key: string | null): void {
    if (!this.restartArmed) return;
    const transition = advanceRestartConfirm(this.restartArmed, {
      kind: 'focus',
      key,
    });
    if (transition.armed) return;
    this.clearRestartTimer();
    this.restartArmed = false;
    if (key !== null) {
      this.rebuildKeepingFocus(key);
    } else {
      this.build();
    }
  }

  /**
   * Opens the hex map, carrying this hangar's war payload (the `⌗ HEX MAP`
   * row).
   *
   * This is the mirror of `HexMapScene.openHangar()`: the map and the hangar
   * are one click apart in **both** directions (GDD §8.2), so a player who
   * entered the war from the menu can read the ring intel before committing to
   * a deployment instead of only launching a blind one from the DEPLOY row.
   * The scene key is written as a literal, like this scene's `'PlayScene'`
   * starts, because `HexMapScene` already imports `HANGAR_SCENE_KEY` from here
   * and importing the key back would create a module cycle.
   */
  openMap(): void {
    this.disarmRestart();
    this.scene.start('HexMapScene', {
      payload: this.payload,
      storage: this.storage,
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
    });
  }

  /**
   * Launches a deployment of the current loadout (AH-0MVUXC2DD003HN0I).
   *
   * Builds the pure deployment payload and starts the shipped `PlayScene`
   * with it — the same run code as Play Game, with only the hangar loadout and
   * the hex-aggression difficulty as inputs. The arcade checkpoint is neither
   * cleared nor written by this path.
   *
   * @param hexId — the hex to attack (defaults to the hex this visit was
   * launched for, then the weakest unheld hex).
   * @returns the deployment payload that was launched (test seam).
   */
  deploy(hexId?: string | null): HangarWarDeployment {
    this.disarmRestart();
    const deployment = buildHangarDeployment(this.payload, {
      hexId: hexId ?? this.targetHexId ?? null,
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

  /** Whether the `⟲ RESTART WAR` row is currently armed (test seam). */
  isRestartArmed(): boolean {
    return this.restartArmed;
  }

  // ── Public query seams (keyboard/pointer tests use these) ───────

  /** The payload currently shown (a detached copy of any injected data). */
  getPayload(): HangarWarPayload {
    return this.payload;
  }

  /** The rendered screen model. */
  getModel(): HangarScreenModel {
    return (
      this.view?.model
      ?? buildHangarScreenModel(this.payload, this.catalogue, {
        targetHexId: this.targetHexId,
      })
    );
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
