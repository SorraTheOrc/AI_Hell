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
import {
  buildHexMapModel,
  type HexMapModel,
} from '../core/hangarWar/hexIntel';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  decideMapAction,
  HANGAR_WAR_TRAVERSAL_DWELL_MS,
} from '../ai/hangarWarTraversal';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import { HANGAR_SCENE_KEY } from './HangarScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';
import {
  renderHexMap,
  type HexMapRow,
  type HexMapView,
} from './hangarWar/hexMap';

/** Scene key (matches the class name, per the scene convention). */
export const HEX_MAP_SCENE_KEY = 'HexMapScene';

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
    });
    this.view = renderHexMap(this, model, {
      onDeploy: (hexId) => this.deploy(hexId),
      onOpenHangar: () => this.openHangar(),
    });
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
      buildHexMapModel(this.payload, { definitions: this.definitions })
    );
  }

  /** Every rendered row, in reading order. */
  getRows(): readonly HexMapRow[] {
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
