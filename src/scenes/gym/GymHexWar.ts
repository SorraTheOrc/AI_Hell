/**
 * GymHexWar — the ring-war verification harness scene
 * (AH-0MVUXC94N008MV63, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — § Gym
 * testability and the bot ("the hex defence resolver and the frontier clock are
 * pure functions and ship in a dedicated `GymHangar` / `GymHexWar` scene, so
 * `take hex → leave bot → AI attacks → hex holds or falls` is exercised end to
 * end without a browser boot").
 *
 * This scene is the **ring half's parity surface**: it boots a real scene and
 * renders the **same hex-map screen** the game's `HexMapScene` renders
 * (`src/scenes/hangarWar/hexMap.ts` over the pure intel model
 * `src/core/hangarWar/hexIntel.ts`) against an **injected** hangar-war ring
 * payload, read-only: the hangar at the centre, the ring around it and every
 * hex's known-ahead intel — held/lost, aggression, the hex's boss and its
 * strengths/weaknesses and grant, its defender and any queued attack. It also
 * exposes the `take hex → leave bot → tick` control surface. It contains **no
 * resolver logic**: the tick transition is delegated to the deterministic
 * harness double (`src/core/hangarWar/fakeFrontierClock.ts`), which the
 * shipped resolver and frontier clock (B3, `src/core/hangarWar/hexDefence.ts`)
 * replace. Because the scene itself only wires payload bookkeeping and the
 * shared map renderer, a future gameplay object runs the same shipped code in
 * the gym as in the game (AGENTS.md gym↔game parity; `docs/GYM_PARITY.md`).
 *
 * The payload arrives as Phaser launch data (`{ payload }`) and defaults to the
 * deterministic sample built from the ring fixtures, so the harness is useful on
 * first load and a scripted capture reproduces exactly. A capture `setup` is
 * consumed through the shared seam as `GymHangar` does: the scene has no player,
 * so `applySceneSetup` is a documented no-op, and the setup's `seed` drives the
 * sample payload (a supplied `payload` wins).
 *
 * ## The integrated map view (AH-0MWEXJ21W003M7RR)
 *
 * The between-sortie defence report is rolled into the map (parent
 * AH-0MWDC3L9I008INDP), so this gym renders the **integrated** map view: the
 * same `buildHexMapModel` + `renderHexMap` pair the game's `HexMapScene`
 * renders, carrying a record produced by the **shipped** frontier tick
 * (`runFrontierTick` at the payload's own clock) — the same record the game
 * carries after a deployment. The map therefore draws the shipped attack
 * arrows and shows the left-hand attack panel for the inspected hex, read-only
 * and without a resolver, arrow or panel rule of its own. There is **no
 * separate `report` view**: the game has no report screen any more, so the gym
 * has no seam for one.
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention and
 * watchable by the capture tooling (`WATCHABLE_GYM_SCENE_KEYS`).
 *
 * @module src/scenes/gym/GymHexWar
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  createSampleHexWarPayload,
  findRingHexFixture,
  ringFixtures,
  type RingHexFixture,
  type RingIndex,
} from '../../core/hangarWar/__fixtures__/ringFixtures';
import {
  applyFakeFrontierTick,
  createFakeFrontierClock,
  type FakeFrontierClock,
} from '../../core/hangarWar/fakeFrontierClock';
import {
  buildHexMapModel,
  type HexMapModel,
} from '../../core/hangarWar/hexIntel';
import {
  frontierClockFor,
  runFrontierTick,
  type FrontierTickRecord,
} from '../../core/hangarWar/hexDefence';
import {
  buildDefenceReport,
  type DefenceReportModel,
} from '../../core/hangarWar/defenceReport';
import type { HangarWarPayload, HexState } from '../../core/hangarWar/types';
import { hexRingDefinitionsFor } from '../../data/hexRingDefinitions';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import {
  applySceneSetup,
  resolveSetupSeed,
  type SceneSetupState,
} from '../core/sceneSetup';
import {
  renderHexMap,
  type HexMapArrow,
  type HexMapRow,
  type HexMapView,
} from '../hangarWar/hexMap';

/** Scene key (== class name, per the gym discovery convention). */
export const GYM_HEX_WAR_SCENE_KEY = 'GymHexWar';

/** Title rendered at the bottom of the gym (asserted by tests). */
export const GYM_HEX_WAR_TITLE = 'HEX WAR — RING HARNESS';

/**
 * Bottom hint line, stating what the harness is and how it is driven.
 *
 * The map is the integrated view (attack arrows + left attack panel from the
 * shipped tick's record), so the hint names both halves the harness shows.
 */
export const GYM_HEX_WAR_HINT =
  'Hex war gym — injected ring payload; take hex → leave bot → tick (arrows + attack panel from the shipped tick record)';

/**
 * Seed used for the sample payload when neither a payload nor a capture setup
 * seed is supplied, so the bare gym always renders the same ring.
 */
export const GYM_HEX_WAR_DEFAULT_SEED = 0x5eed_3c4b;

/** Launch data accepted by {@link GymHexWar}. */
export interface GymHexWarData extends SceneSetupState {
  /** Payload to render and drive (read-only: the scene works on a copy). */
  payload?: HangarWarPayload;
  /** Fixture ring the sample payload is built from (defaults to ring 1). */
  ringIndex?: RingIndex;
}

/** One applied frontier tick, as reported by the control surface. */
export interface GymTickResult {
  /** The tick index that was applied. */
  readonly tick: number;
  /** The held hex the AI pressured, or `null` when it attacked nothing. */
  readonly attackedHexId: string | null;
  /** True when the attacked hex was retaken this tick (false when not attacked). */
  readonly fell: boolean;
}

/** Detached copy, so rendering/control-surface work never mutates caller data. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** The hex in `payload` with `hexId`, or `undefined`. */
function findHex(
  payload: HangarWarPayload,
  hexId: string,
): HexState | undefined {
  return payload.ring.hexes.find((hex) => hex.id === hexId);
}

/**
 * Takes a hex on a detached copy (control surface: "take hex").
 *
 * Only the persisted ownership flag is set; boss defeat, granted weapon and the
 * capture cycle's bookkeeping are later items (B5). An unknown id is a no-op, so
 * a mis-targeted control action never throws.
 */
export function takeHexOnPayload(
  payload: HangarWarPayload,
  hexId: string,
): HangarWarPayload {
  const next = clonePayload(payload);
  const hex = findHex(next, hexId);
  if (hex) hex.held = true;
  return next;
}

/**
 * Leaves a bot defending a held hex on a detached copy (control surface: "leave
 * bot").
 *
 * The caller supplies the already-resolved defender rating (the hangar-upgrade
 * derivation is A4's `defenderRatingFromUpgrades`), so the harness never
 * duplicates that rule. An unheld or unknown hex is a no-op.
 */
export function leaveBotOnPayload(
  payload: HangarWarPayload,
  hexId: string,
  hullId: string,
  defenceRating: number,
): HangarWarPayload {
  const next = clonePayload(payload);
  const hex = findHex(next, hexId);
  if (hex?.held) {
    hex.defender = { hullId, defenceRating, bankedMinerals: 0 };
  }
  return next;
}

/**
 * Read-only summary lines for a ring payload: the held count and frontier tick,
 * then one line per hex with the known-ahead intel.
 *
 * Pure and total so tests can assert the display without booting a scene. Hexes
 * are joined to their fixture by id for the boss/weakness/grant intel; a payload
 * hex with no fixture (an injected payload not built from the fixtures) still
 * renders its persisted state.
 *
 * @param payload — the payload to summarise.
 * @param fixtures — the fixtures to enrich the hex lines from.
 * @param clock — the harness clock (its `tick` is displayed).
 * @returns the summary lines, in render order.
 */
export function hexWarSummaryLines(
  payload: HangarWarPayload,
  fixtures: readonly RingHexFixture[],
  clock: FakeFrontierClock,
): string[] {
  const { ring } = payload;
  const held = ring.hexes.filter((hex) => hex.held).length;
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

  const lines = [
    `Ring ${ring.ringIndex} — ${held}/${ring.hexes.length} hexes held · frontier tick ${clock.tick}`,
  ];

  for (const hex of ring.hexes) {
    const fixture = fixtureById.get(hex.id) ?? findRingHexFixture(hex.id);
    const parts = [
      hex.held ? '[HELD]' : '[LOST]',
      `${hex.id} (${hex.q},${hex.r})`,
      `AGG ${hex.aggression}`,
    ];
    if (fixture) {
      parts.push(
        `boss ${fixture.boss}`,
        `weak: ${fixture.weaknesses.join(', ')}`,
        `grant: ${fixture.grants}`,
      );
    }
    if (hex.held && hex.defender) {
      parts.push(`bot ${hex.defender.hullId} (${hex.defender.defenceRating})`);
    }
    lines.push(parts.join(' · '));
  }

  return lines;
}

export class GymHexWar extends Phaser.Scene {
  /** The working payload (a detached copy of any injected data). */
  private payload: HangarWarPayload = createSampleHexWarPayload(
    GYM_HEX_WAR_DEFAULT_SEED,
  );
  /** The fixture ring the sample payload is built from. */
  private fixtures: readonly RingHexFixture[] = ringFixtures(1);
  /** The deterministic harness frontier clock. */
  private clock: FakeFrontierClock = createFakeFrontierClock(
    GYM_HEX_WAR_DEFAULT_SEED,
  );
  /** Capture setup supplied as scene-start data (documented no-op for player state). */
  private setup: SceneSetupState | null = null;
  /** The shared map render (rebuilt when the control surface changes it). */
  private view: HexMapView | null = null;

  /**
   * The shipped between-sortie record the current map view draws (the same
   * record the game carries after a deployment), or `null` before the first
   * render.
   */
  private record: FrontierTickRecord | null = null;

  constructor() {
    super({ key: GYM_HEX_WAR_SCENE_KEY });
  }

  /**
   * Resolves the payload to drive from the launch data: an injected payload
   * wins; otherwise the fixture sample is generated from the capture setup's
   * seed (or {@link GYM_HEX_WAR_DEFAULT_SEED}) for the requested ring.
   */
  init(data?: GymHexWarData | null): void {
    this.setup = data ?? null;
    const seed = resolveSetupSeed(data ?? null);
    const ringIndex = data?.ringIndex ?? 1;
    this.fixtures = ringFixtures(ringIndex);
    this.payload = data?.payload
      ? clonePayload(data.payload)
      : createSampleHexWarPayload(seed ?? GYM_HEX_WAR_DEFAULT_SEED, ringIndex);
    this.clock = createFakeFrontierClock(this.payload.seed);
  }

  create(): void {
    // Shared scripted-scene setup seam: the harness has no player, so the
    // loadout/power-up half is a documented no-op; the seed was already
    // consumed by `init`, so nothing supplied is silently dropped.
    applySceneSetup({ getPlayer: () => null }, this.setup);

    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this.renderMap();

    this.add
      .text(40, GAME_HEIGHT - 48, GYM_HEX_WAR_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#555555',
      })
      .setOrigin(0, 1);

    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 32, GYM_HEX_WAR_TITLE, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#555555',
      })
      .setOrigin(0.5, 1);
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * Rebuilds the shared integrated hex-map view after a control-surface
   * action.
   *
   * The map is rendered with **no handlers**, so every row is reported
   * non-actionable and the gym stays read-only by construction — the same
   * model and renderer the game's `HexMapScene` uses (gym↔game parity),
   * including the rolled-in report: the shipped tick's record over the current
   * payload feeds `buildHexMapModel`, which gives the renderer its attack
   * arrows and left-hand attack panel. The gym owns no arrow or panel rule.
   */
  private renderMap(): void {
    this.view?.destroy();
    const record = this.shippedTickRecord();
    this.record = record;
    const model = buildHexMapModel(this.payload, {
      definitions: hexRingDefinitionsFor(this.payload.ring.ringIndex),
      record,
    });
    this.view = renderHexMap(this, model);
  }

  /**
   * The between-sortie record the map view carries: the **shipped** frontier
   * tick's record over the current payload (the same `runFrontierTick` the game
   * runs after a deployment), never a gym-local re-derivation.
   */
  private shippedTickRecord(): FrontierTickRecord {
    return runFrontierTick(this.payload, {
      clock: frontierClockFor(this.payload),
    }).record;
  }

  // ── Control surface ───────────────────────────────────────────────

  /** The payload currently driven (a detached copy of any injected data). */
  getPayload(): HangarWarPayload {
    return clonePayload(this.payload);
  }

  /** The fixture ring the sample payload was built from. */
  getFixtures(): readonly RingHexFixture[] {
    return [...this.fixtures];
  }

  /** The deterministic harness clock (its `tick` is the frontier's tick count). */
  getClock(): FakeFrontierClock {
    return this.clock;
  }

  /** The rendered map model (the shared intel view, arrows included). */
  getMapModel(): HexMapModel | null {
    return this.view?.model ?? null;
  }

  /** Every drawn attack arrow (one per carried-attack entry), or none. */
  getMapArrows(): readonly HexMapArrow[] {
    return this.view?.arrows ?? [];
  }

  /**
   * The defence report model the integrated view is built from: the **shipped**
   * frontier tick's record over this payload, read through the shipped report
   * model. The model's `attackDetails` rows are what the left panel renders.
   */
  getDefenceReport(): DefenceReportModel {
    return buildDefenceReport(
      this.payload,
      this.record ?? this.shippedTickRecord(),
    );
  }

  /**
   * The between-sortie tick record the current map view carries (a detached
   * copy), or `null` before the first render. Never persisted.
   */
  getTickRecord(): FrontierTickRecord | null {
    return this.record === null
      ? null
      : (JSON.parse(JSON.stringify(this.record)) as FrontierTickRecord);
  }

  /**
   * Moves the map's focus to `key` (control surface: inspect a hex's panels).
   * Every displayed hex is focusable even in a handler-less render, so this is
   * the renderer's own `focusRow` seam — the same one the game uses — and the
   * gym still owns no panel rule.
   *
   * @returns whether the focus moved.
   */
  focusMapRow(key: string): boolean {
    return this.view?.focusRow(key) ?? false;
  }

  /** The focused row key, or `null` when nothing is focusable. */
  getMapFocusKey(): string | null {
    return this.view?.getFocusedKey() ?? null;
  }

  /**
   * The left-hand attack panel's text (the inspected attack's row), or `''`
   * when the inspected hex is in no attack.
   */
  getLeftPanelText(): string {
    return this.view?.getLeftPanelText() ?? '';
  }

  /** Whether the left-hand attack panel is showing. */
  isLeftPanelVisible(): boolean {
    return this.view?.isLeftPanelVisible() ?? false;
  }

  /** Every rendered map row (read-only: none is actionable in the gym). */
  getMapRows(): readonly HexMapRow[] {
    return this.view?.rows ?? [];
  }

  /** The hex the read-only detail panel shows (defaults to the model's default/first hex). */
  getMapPanelKey(): string | null {
    return this.view?.getPanelKey() ?? null;
  }

  /** The read-only detail panel's current text (the default hex's full intel). */
  getMapPanelText(): string {
    return this.view?.getPanelText() ?? '';
  }

  /** The summary lines the harness publishes (the ring's read-only summary). */
  getSummaryLines(): string[] {
    return hexWarSummaryLines(this.payload, this.fixtures, this.clock);
  }

  /** Takes `hexId` into the player's hands (control surface: take hex). */
  takeHex(hexId: string): void {
    this.payload = takeHexOnPayload(this.payload, hexId);
    this.renderMap();
  }

  /** Leaves a bot defending `hexId` (control surface: leave bot). */
  leaveBot(hexId: string, hullId: string, defenceRating: number): void {
    this.payload = leaveBotOnPayload(
      this.payload,
      hexId,
      hullId,
      defenceRating,
    );
    this.renderMap();
  }

  /**
   * Runs `ticks` deterministic frontier ticks (control surface: tick → holds or
   * falls). The transition is the pure harness stand-in, so the scene owns no
   * resolver logic. The map re-renders after the ticks, so the integrated view
   * shows the shipped record for the resulting payload — exactly what the game
   * would carry for it.
   *
   * @returns one result per applied tick, in order.
   */
  tick(ticks = 1): readonly GymTickResult[] {
    const step = Number.isFinite(ticks) ? Math.max(0, Math.floor(ticks)) : 0;
    const results: GymTickResult[] = [];

    for (let i = 0; i < step; i += 1) {
      const applied = applyFakeFrontierTick(this.payload, this.clock);
      this.payload = applied.payload;
      this.clock = applied.clock;

      const attackedHexId = applied.event.attack?.hexId ?? null;
      const attacked = attackedHexId
        ? findHex(this.payload, attackedHexId)
        : undefined;
      results.push({
        tick: applied.event.tick,
        attackedHexId,
        fell: attacked !== undefined && !attacked.held,
      });
    }

    this.renderMap();
    return results;
  }
}
