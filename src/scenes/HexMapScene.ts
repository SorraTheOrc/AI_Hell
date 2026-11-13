/**
 * Hex map scene — the player-facing hex ring map of the Hangar War
 * (AH-0MVUXCAG90086LH2, part of **Build Candidate D — Hangar War**).
 *
 * The hangar sits at the centre and the current ring surrounds it; every hex
 * publishes the **known-ahead intel** before the player commits to anything:
 * held/unheld, aggression, the boss that holds it, what that boss is strong and
 * weak against, the weapon or upgrade the hex grants, the defending bot and any
 * queued attack. Design of record:
 * `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene surface and
 * § *Known-ahead intel and anti-checklist mitigations*.
 *
 * **The scene is a view, not a rule.** The model comes from the pure
 * `src/core/hangarWar/hexIntel.ts` (payload + authored hex definitions +
 * resolver preview) and is drawn by the shared `./hangarWar/hexMap` renderer,
 * which `GymHexWar` renders too (AGENTS.md gym↔game parity). Deploying a hex
 * reuses the shipped deployment path (`./hangarWar/hangarDeployment` →
 * `PlayScene` with the hangar loadout and the hex-aggression difficulty), so the
 * map introduces no second deployment rule and never touches the arcade
 * checkpoint.
 *
 * Navigation: activating an **unheld** hex deploys at it; the `◀ HANGAR` row
 * opens `HangarScene` (one click, the design's "what I own" and "what I hold"
 * one click apart); ESC returns to the main menu. The payload can be injected
 * as launch data (`{ payload, storage, definitions }`) so tests and the capture
 * tooling boot a deterministic war without touching `localStorage`.
 *
 * ## Deployment landing surface (`AH-0MWDC3L9I008INDP`)
 *
 * A finished deployment lands here (AH-0MWEXIOZZ009UX14), not on a separate
 * report screen: the launch data carries the between-sortie tick record (the
 * map's attack arrows and left-hand attack panel), the run result line
 * (`RUN: VICTORY · score 1200`) and any resolved mini-boss reward. The reward is
 * presented over the **paused** map through the shipped
 * `MiniBossWheelScene`/`MineralChoiceScene` overlay — the same overlay the
 * arcade run uses — and the map resumes normal interaction once it resolves.
 * All three are **transient launch data**: nothing is persisted, so a later
 * menu/hangar re-entry renders no arrows, no run line and no reward.
 *
 * @module src/scenes/HexMapScene
 */

import Phaser from 'phaser';

import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { materialiseRing } from '../core/hangarWar/captureCycle';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import type { HexRingDefinition } from '../core/hangarWar/hexRing';
import type { FrontierTickRecord } from '../core/hangarWar/hexDefence';
import {
  buildHexMapModel,
  type HexMapModel,
} from '../core/hangarWar/hexIntel';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  decideMapAction,
  HANGAR_WAR_TRAVERSAL_DWELL_MS,
} from '../ai/hangarWarTraversal';
import type { MiniBossWinReward } from '../powerups/miniBossWheel';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import { HANGAR_SCENE_KEY } from './HangarScene';
import { MINI_BOSS_WHEEL_SCENE_KEY } from './MiniBossWheelScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';
import {
  renderHexMap,
  type HexMapArrow,
  type HexMapRow,
  type HexMapView,
} from './hangarWar/hexMap';

/** Scene key (matches the class name, per the scene convention). */
export const HEX_MAP_SCENE_KEY = 'HexMapScene';

/** Scene key of the shared hold-full/mini-boss choice overlay. */
const MINERAL_CHOICE_SCENE_KEY = 'MineralChoiceScene';

/** Launch data accepted by {@link HexMapScene}. */
export interface HexMapSceneData {
  /**
   * Payload to show instead of the stored one (tests, captures and the attract
   * traversal). Defaults to the versioned store's payload.
   */
  payload?: HangarWarPayload;
  /**
   * Storage adapter for persistence. Omitted → the store's `localStorage`
   * adapter; `null` → in-memory only (a test that must not touch storage).
   */
  storage?: HangarWarStorage | null;
  /** Authored ring definitions to render (defaults to the shipped table). */
  definitions?: readonly HexRingDefinition[];
  /**
   * The between-sortie tick record carried from a deployment
   * (AH-0MWDC3L9I008INDP). Transient launch data: it feeds the map's attack
   * arrows and left-hand attack panel for this landing only and is never
   * persisted, so a later re-entry without it draws neither.
   */
  record?: FrontierTickRecord;
  /**
   * Whether the deployment that just ended was won. Renders the run result
   * line (`RUN: VICTORY|DEFEAT · score N`) for this landing only. Omitted on a
   * plain menu/hangar entry, which shows no run line.
   */
  won?: boolean | null;
  /** The finished deployment's final score (renders with the run line). */
  score?: number;
  /**
   * The mini-boss reward a winning deployment resolved and carried here
   * (parent AH-0MWBW1B1Z0059CC2). Presented over the **paused** map through the
   * shipped overlay and consumed exactly once; `null`/omitted on a loss, so the
   * map is interactive immediately.
   */
  reward?: MiniBossWinReward | null;
  /**
   * Bot-driven attract traversal (AH-0MVUXCBBK004EJIP): the pure
   * `decideMapAction` picks the weakest adjacent hex and deploys, so the demo
   * never stalls on the map.
   */
  demo?: boolean;
  /** Demo dwell override in milliseconds (tests use a short one). */
  demoDwellMs?: number;
}

/**
 * The hex map screen.
 */
export class HexMapScene extends Phaser.Scene {
  /** The payload currently shown (a detached copy of injected data). */
  private payload: HangarWarPayload = createDefaultPayload(0);

  /** Injected storage adapter, or `undefined` for the store's default. */
  private storage: HangarWarStorage | null | undefined;

  /** Authored ring definitions in use (shipped table unless injected). */
  private definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS;

  /**
   * The transient between-sortie tick record carried by this landing, or
   * `undefined` when the map was entered without one (a later menu/hangar
   * entry). Never persisted.
   */
  private record?: FrontierTickRecord;

  /** The finished deployment's result, or `null` when not supplied. */
  private won: boolean | null = null;

  /** The finished deployment's score (renders with the run line). */
  private score = 0;

  /**
   * The resolved mini-boss reward carried by this landing, or `null` when there
   * is none (a loss, a plain entry, or once it has been presented). Consumed
   * exactly once.
   */
  private reward: MiniBossWinReward | null = null;

  /** The rendered map (rebuilt after every change). */
  private view: HexMapView | null = null;

  /** Whether the attract traversal is driving this screen. */
  private demo = false;

  /** Demo dwell override (production uses the shared traversal dwell). */
  private demoDwellMs?: number;

  /** The demo auto-advance timer, cleared on shutdown. */
  private demoTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super(HEX_MAP_SCENE_KEY);
  }

  init(data?: HexMapSceneData | null): void {
    this.storage = data?.storage;
    this.definitions = data?.definitions ?? HEX_RING_DEFINITIONS;
    this.record = data?.record;
    this.won = data?.won ?? null;
    this.score = data?.score ?? 0;
    this.reward = data?.reward ?? null;
    this.demo = data?.demo === true;
    this.demoDwellMs = data?.demoDwellMs;
    const injected = data?.payload;
    const loaded = injected ?? this.loadPayload();
    // A fresh war (or a save written before the ring model landed) has an empty
    // stored ring. Materialise it from the authored definitions so the map, the
    // deployment and the capture cycle all target real hexes; an injected
    // payload is never persisted.
    this.payload = materialiseRing(loaded, this.definitions);
    if (
      injected === undefined
      && this.payload.ring.hexes.length > loaded.ring.hexes.length
    ) {
      this.persist();
    }
  }

  create(): void {
    this.build();
    addBackToMenuOnEsc(this);
    // A carried mini-boss reward is presented over the paused map first; the
    // demo dwell (which would deploy from the map) only starts once it is
    // resolved, so the traversal cannot skip past the reward.
    if (this.reward !== null) {
      this.presentReward();
      return;
    }
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

  /** Persists the materialised ring (a fresh war's first write). */
  private persist(): void {
    // A demo run is a demonstration, not progress: it never overwrites the
    // player's war.
    if (this.demo || this.storage === null) return;
    if (this.storage === undefined) {
      saveHangarWarPayload(this.payload);
    } else {
      saveHangarWarPayload(this.payload, this.storage);
    }
  }

  /** (Re)renders the map from the current payload. */
  private build(): void {
    this.view?.destroy();
    this.view = null;
    const model = buildHexMapModel(this.payload, {
      definitions: this.definitions,
      record: this.record,
    });
    this.view = renderHexMap(this, model, {
      onDeploy: (hexId) => this.deploy(hexId),
      onOpenHangar: () => this.openHangar(),
    }, { runLine: this.runLine() });
  }

  /**
   * The finished deployment's result line, or `null` when this landing carried
   * no result (a plain menu/hangar entry). Transient launch data.
   */
  private runLine(): string | null {
    if (this.won === null) return null;
    return `${this.won ? 'RUN: VICTORY' : 'RUN: DEFEAT'} · score ${this.score}`;
  }

  /**
   * Launches a deployment at `hexId` through the shipped deployment path.
   *
   * The payload is the map's current war state, so the deployment carries the
   * hangar-resolved hull/loadout and the hex's aggression-selected difficulty.
   * Nothing is written to the arcade checkpoint.
   *
   * @param hexId — the hex to attack.
   * @returns the deployment payload that was launched (test seam).
   */
  deploy(hexId: string): HangarWarDeployment {
    const deployment = buildHangarDeployment(this.payload, { hexId });
    // The deployment carries this map's payload, so the run resolves its
    // capture and its between-sortie tick against exactly the war on screen —
    // including a payload injected by a test or the attract traversal, which
    // the versioned store never sees.
    this.scene.start('PlayScene', {
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
      resume: false,
      hangarWar: deployment,
    });
    return deployment;
  }

  /**
   * Opens the hangar screen, carrying the map's payload so what the player
   * sees on both screens is one war state.
   */
  openHangar(): void {
    this.scene.start(HANGAR_SCENE_KEY, {
      payload: this.payload,
      storage: this.storage,
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
    });
  }

  /**
   * Presents the carried mini-boss reward over the paused map, or does nothing
   * when none is pending (already presented, a loss, or a plain entry).
   *
   * The reward is the **shipped** overlay — `MiniBossWheelScene` for the wheel,
   * or the shared three-option choice overlay for the empty-owned fallback —
   * launched with the wedges/outcome the run resolved, so one overlay
   * implementation serves both the arcade in-run reward and this win-path
   * reveal (no second reward screen, no duplicated wheel logic). The map is
   * paused while the modal overlay runs, exactly like the in-run reward, and
   * resumes normal interaction once it resolves.
   *
   * The reward is consumed before the overlay launches, so a second
   * presentation path cannot re-present it. A boot without the overlay
   * registered (headless test, misconfig) must not stall on a surface it can
   * never show: it is consumed and the map stays interactive.
   *
   * @returns whether a pending reward was consumed by this call.
   */
  presentReward(): boolean {
    const reward = this.reward;
    if (reward === null) return false;
    // Consume the reward: it is presented exactly once.
    this.reward = null;
    this.demoTimer?.remove(false);
    this.demoTimer = null;

    const overlayKey =
      reward.kind === 'wheel'
        ? MINI_BOSS_WHEEL_SCENE_KEY
        : MINERAL_CHOICE_SCENE_KEY;
    if (!this.scene.manager.getScene(overlayKey)) {
      // Nothing to present the reward with: keep the map live (and the demo
      // traversal moving) rather than pausing on a screen that cannot exist.
      if (this.demo) this.scheduleDemoAdvance();
      return true;
    }

    // Demo/attract mode auto-resolves the overlay so the traversal cannot
    // stall on it; normal play waits for the player.
    const autoMs = this.demo
      ? this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS
      : 0;

    this.scene.pause();
    if (reward.kind === 'wheel') {
      this.scene.launch(MINI_BOSS_WHEEL_SCENE_KEY, {
        origin: 'HexMapScene-miniBoss',
        wedges: reward.wedges,
        outcome: reward.outcome,
        ...(autoMs > 0 ? { autoSpinMs: autoMs } : {}),
        // Single overlay contract: the map resumes once the wheel lands. The
        // outcome was already applied to the run at defeat.
        onResult: () => this.afterReward(),
      });
      return true;
    }

    this.scene.launch(MINERAL_CHOICE_SCENE_KEY, {
      origin: 'HexMapScene-miniBoss',
      options: [...reward.options],
      ...(autoMs > 0 ? { autoSelectMs: autoMs } : {}),
      onSelect: () => this.afterReward(),
    });
    return true;
  }

  /**
   * Resumes the map after its reward overlay resolved.
   *
   * The map is already the landing surface, so there is nowhere left to go: it
   * simply becomes interactive again (and the demo traversal restarts its
   * dwell, so the attract bot continues from the map).
   */
  private afterReward(): void {
    this.scene.resume();
    if (this.demo) this.scheduleDemoAdvance();
  }

  /**
   * Schedules the attract traversal's single step on the map.
   *
   * The decision is the pure, tested `decideMapAction` (the weakest adjacent
   * unheld hex, or the hangar once the ring is secured); the scene only owns
   * the dwell that applies it, so the map never stalls in demo mode.
   */
  private scheduleDemoAdvance(): void {
    this.demoTimer?.remove(false);
    const dwell = this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS;
    this.demoTimer = this.time.delayedCall(dwell, () => {
      if (!this.sys.isActive()) return;
      const action = decideMapAction(this.payload, {
        definitions: this.definitions,
      });
      if (action.kind === 'deploy' && action.hexId !== null) {
        this.deploy(action.hexId);
        return;
      }
      // A secured ring has nothing left to attack: skip to the hangar.
      this.openHangar();
    });
  }

  /** Whether the attract traversal is driving this screen (test seam). */
  isDemo(): boolean {
    return this.demo;
  }

  // ── Public query seams (keyboard/pointer tests use these) ───────

  /** The payload currently shown (a detached copy of any injected data). */
  getPayload(): HangarWarPayload {
    return JSON.parse(JSON.stringify(this.payload)) as HangarWarPayload;
  }

  /** The pure map model currently rendered. */
  getModel(): HexMapModel {
    return (
      this.view?.model ??
      buildHexMapModel(this.payload, {
        definitions: this.definitions,
        record: this.record,
      })
    );
  }

  /**
   * The transient between-sortie tick record this landing carried (a detached
   * copy), or `null` when the map was entered without one. Never persisted.
   */
  getRecord(): FrontierTickRecord | null {
    return this.record === undefined
      ? null
      : (JSON.parse(JSON.stringify(this.record)) as FrontierTickRecord);
  }

  /**
   * The finished deployment's result line (`RUN: VICTORY|DEFEAT · score N`),
   * or `null` when this landing carried no result. Never persisted.
   */
  getRunLine(): string | null {
    return this.runLine();
  }

  /**
   * The mini-boss reward still waiting to be presented, or `null` once it has
   * been shown (or when none was carried). A test/inspection seam.
   */
  getReward(): MiniBossWinReward | null {
    return this.reward;
  }

  /** Every rendered row, in reading order. */
  getRows(): readonly HexMapRow[] {
    return this.view?.rows ?? [];
  }

  /** Every drawn attack arrow (one per carried-attack entry), or none. */
  getArrows(): readonly HexMapArrow[] {
    return this.view?.arrows ?? [];
  }

  /**
   * The left-hand attack panel's text (the focused attack's row), or `''`
   * when the focused hex is in no attack.
   */
  getLeftPanelText(): string {
    return this.view?.getLeftPanelText() ?? '';
  }

  /** Whether the left-hand attack panel is showing. */
  isLeftPanelVisible(): boolean {
    return this.view?.isLeftPanelVisible() ?? false;
  }

  /** The focused row key, or `null` when no row is focusable. */
  getFocusedKey(): string | null {
    return this.view?.getFocusedKey() ?? null;
  }

  /** The hex the detail panel currently shows, or `null` when the map has no hexes. */
  getPanelKey(): string | null {
    return this.view?.getPanelKey() ?? null;
  }

  /** The detail panel's current text (the focused hex's full intel). */
  getPanelText(): string {
    return this.view?.getPanelText() ?? '';
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
