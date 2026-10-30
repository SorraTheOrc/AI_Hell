/**
 * GymHangar — the hangar-war gym scene
 * (AH-0MVUXC074005IGXZ, part of **Build Candidate D — Hangar War**).
 *
 * The hangar slice's parity surface: it boots a real scene and renders an
 * **injected** hangar-war payload (`HangarWarPayload`, `src/core/hangarWar/`)
 * read-only — banked salvage, the equipped fleet, ring progress and the queued
 * attacks. It deliberately contains **no economy, banking or resolver
 * behaviour**: those ship as pure modules exercised here, so the same code the
 * game uses is demonstrated in a gym without a second implementation
 * (AGENTS.md gym↔game parity; `docs/GYM_PARITY.md`).
 *
 * The payload arrives as Phaser launch data (`{ payload }`) and defaults to the
 * deterministic sample fixture (`createSampleHangarWarPayload`) so the gym is
 * useful on first load and a scripted capture reproduces exactly. A capture
 * `setup` is consumed through the shared seam, as `GymCurveSequencer` does:
 * the scene has no player, so `applySceneSetup` is a documented no-op here, and
 * the setup's `seed` drives the sample payload (a supplied `payload` wins).
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention and
 * watchable by the capture tooling (`WATCHABLE_GYM_SCENE_KEYS`).
 *
 * @module src/scenes/gym/GymHangar
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { createSampleHangarWarPayload } from '../../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import {
  applySceneSetup,
  resolveSetupSeed,
  type SceneSetupState,
} from '../core/sceneSetup';

/** Scene key (== class name, per the gym discovery convention). */
export const GYM_HANGAR_SCENE_KEY = 'GymHangar';

/** Title rendered at the top of the gym (asserted by tests). */
export const GYM_HANGAR_TITLE = 'HANGAR WAR';

/** Bottom hint line, stating that the view is read-only. */
export const GYM_HANGAR_HINT =
  'Hangar gym — injected payload, read-only (economy lives in the pure hangar modules)';

/**
 * Seed used for the sample payload when neither a payload nor a capture setup
 * seed is supplied, so the bare gym always renders the same state.
 */
export const GYM_HANGAR_DEFAULT_SEED = 0x5eed_1a2b;

/** Launch data accepted by {@link GymHangar}. */
export interface GymHangarData extends SceneSetupState {
  /** Payload to render (read-only). Defaults to the deterministic sample. */
  payload?: HangarWarPayload;
}

/**
 * Read-only summary of a hangar-war payload, one line per rendered row.
 *
 * Pure and total so tests (and later UI items) can assert the display without
 * booting a scene. A partial ring renders from the hexes the payload knows
 * about — a partial ring is never discarded or padded.
 *
 * @param payload — the payload to summarise.
 * @returns the summary lines, in render order.
 */
export function hangarSummaryLines(payload: HangarWarPayload): string[] {
  const { hangar, ring } = payload;
  const held = ring.hexes.filter((hex) => hex.held).length;
  const loadout = hangar.activeLoadout;
  const weapons =
    loadout.startingWeapons.length > 0 ? loadout.startingWeapons.join(', ') : 'none';
  const modifiers =
    loadout.modifiers.length > 0 ? loadout.modifiers.join(', ') : 'none';

  return [
    `Banked salvage: ${hangar.bankedMinerals} minerals · ${hangar.bankedCores} cores`,
    `Hull ${hangar.activeHull} · starting weapons ${weapons} · modifiers ${modifiers}`,
    `Ring ${ring.ringIndex} — ${held}/${ring.hexes.length} hexes held`,
    `Pending attacks: ${payload.pendingAttacks.length} · best score: ${payload.bestScore}`,
  ];
}

/** Detached copy of a payload, so rendering can never mutate the caller's data. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

export class GymHangar extends Phaser.Scene {
  /** The payload being rendered (never mutated after `init`). */
  private payload: HangarWarPayload = createSampleHangarWarPayload(
    GYM_HANGAR_DEFAULT_SEED,
  );
  /** Capture setup supplied as scene-start data (documented no-op for player state). */
  private setup: SceneSetupState | null = null;

  constructor() {
    super({ key: GYM_HANGAR_SCENE_KEY });
  }

  /**
   * Resolves the payload to render from the launch data: an injected payload
   * wins; otherwise the sample fixture is generated from the capture setup's
   * seed (or {@link GYM_HANGAR_DEFAULT_SEED}).
   */
  init(data?: GymHangarData | null): void {
    this.setup = data ?? null;
    const seed = resolveSetupSeed(data ?? null);
    this.payload = data?.payload
      ? clonePayload(data.payload)
      : createSampleHangarWarPayload(seed ?? GYM_HANGAR_DEFAULT_SEED);
  }

  create(): void {
    // Shared scripted-scene setup seam (AH-0MVRMHYJR000Y9H8): the gym has no
    // player, so the loadout/power-up half is a documented no-op; the seed was
    // already consumed by `init`, so nothing supplied is silently dropped.
    applySceneSetup({ getPlayer: () => null }, this.setup);

    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this.add
      .text(GAME_WIDTH / 2, 90, GYM_HANGAR_TITLE, {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#00ffff',
      })
      .setOrigin(0.5);

    hangarSummaryLines(this.payload).forEach((line, index) => {
      this.add.text(80, 160 + index * 34, line, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#00ff88',
      });
    });

    this.add
      .text(
        GAME_WIDTH / 2,
        GAME_HEIGHT - 16,
        GYM_HANGAR_HINT,
        {
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#555555',
        },
      )
      .setOrigin(0.5);
  }

  /** The payload currently rendered (a detached copy of any injected data). */
  getPayload(): HangarWarPayload {
    return this.payload;
  }

  /** The summary lines rendered on screen, in display order. */
  getSummaryLines(): string[] {
    return hangarSummaryLines(this.payload);
  }
}
