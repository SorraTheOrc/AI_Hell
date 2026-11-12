/**
 * Defence report scene — the between-sortie report of the Hangar War
 * (AH-0MVUXCBBK004EJIP, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface ("A **between-sortie defence report**: which hexes were attacked,
 * which held, which fell, and what it would take to retake them") and the
 * *opaque defence* failure mode it mitigates ("show the numbers (defender
 * rating vs. attacking force)").
 *
 * **The scene is a view, not a rule.** The model comes from the pure
 * `src/core/hangarWar/defenceReport.ts` (the resolver's per-tick record + the
 * stored payload) and is drawn by the shared `./hangarWar/defenceReport`
 * renderer, which `GymHexWar` renders too (AGENTS.md gym↔game parity). No
 * defence is resolved, no hex changes hands and no battle is simulated here —
 * the frontier tick already ran when the deployment ended, and this screen only
 * reports it.
 *
 * Navigation: the single `▶ CONTINUE TO THE MAP` action returns to
 * `HexMapScene` carrying the same war payload, so the player (or the attract
 * bot) is always one step from the map. ESC returns to the main menu, per the
 * shipped scene conventions.
 *
 * The payload and the tick record can be injected as launch data
 * (`{ payload, record, storage }`) so tests and the attract traversal boot a
 * deterministic report without touching `localStorage`; a direct boot loads the
 * stored payload and reports a **quiet** tick rather than failing.
 *
 * @module src/scenes/DefenceReportScene
 */

import Phaser from 'phaser';

import {
  createDefaultPayload,
  loadHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { materialiseRing } from '../core/hangarWar/captureCycle';
import type { FrontierTickRecord } from '../core/hangarWar/hexDefence';
import type { HexRingDefinition } from '../core/hangarWar/hexRing';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import {
  buildDefenceReport,
  type DefenceReportModel,
} from '../core/hangarWar/defenceReport';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  decideReportAction,
  HANGAR_WAR_TRAVERSAL_DWELL_MS,
} from '../ai/hangarWarTraversal';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import type { MiniBossWinReward } from '../powerups/miniBossWheel';
import { HEX_MAP_SCENE_KEY } from './HexMapScene';
import { MINI_BOSS_WHEEL_SCENE_KEY } from './MiniBossWheelScene';
import {
  renderDefenceReport,
  type DefenceReportRow,
  type DefenceReportView,
} from './hangarWar/defenceReport';

/** Scene key (matches the class name, per the scene convention). */
export const DEFENCE_REPORT_SCENE_KEY = 'DefenceReportScene';

/** Scene key of the shared hold-full/mini-boss choice overlay. */
const MINERAL_CHOICE_SCENE_KEY = 'MineralChoiceScene';

/** Launch data accepted by {@link DefenceReportScene}. */
export interface DefenceReportSceneData {
  /**
   * Payload to show instead of the stored one (the deployment's war state).
   * Defaults to the versioned store's payload.
   */
  payload?: HangarWarPayload;
  /**
   * The frontier tick's record — the numbers this report renders. Omitted (a
   * direct boot) → a quiet record at the payload's own tick position.
   */
  record?: FrontierTickRecord;
  /** Whether the deployment that just ended was won (renders the run line). */
  won?: boolean | null;
  /** The deployment's final score (renders with the run line). */
  score?: number;
  /**
   * The mini-boss reward a winning deployment resolved and carried here
   * (parent AH-0MWBW1B1Z0059CC2, producer Q2 = b). Omitted/`null` on a loss, so
   * the report goes straight to the map.
   */
  reward?: MiniBossWinReward | null;
  /**
   * Storage adapter for persistence. Omitted → the store's `localStorage`
   * adapter; `null` → in-memory only (a test that must not touch storage).
   */
  storage?: HangarWarStorage | null;
  /** Authored ring definitions (defaults to the shipped table). */
  definitions?: readonly HexRingDefinition[];
  /** Bot-driven attract traversal: auto-continue after the dwell. */
  demo?: boolean;
  /** Demo dwell override in milliseconds (tests use a short one). */
  demoDwellMs?: number;
}

/**
 * The defence report screen.
 */
export class DefenceReportScene extends Phaser.Scene {
  /** The payload the report was generated from (a detached copy). */
  private payload: HangarWarPayload = createDefaultPayload(0);

  /** The tick record being reported. */
  private record: FrontierTickRecord = {
    tick: 0,
    playerStrength: 0,
    aggressionBudget: 0,
    beatableCeiling: 0,
    deltas: [],
    rose: 0,
    fell: 0,
    attacks: [],
  };

  /** The finished deployment's result, or `null` when not supplied. */
  private won: boolean | null = null;

  /** The finished deployment's score. */
  private score = 0;

  /**
   * The resolved mini-boss reward to reveal before the map, or `null` when
   * there is none (a loss, or the arcade run). Consumed exactly once.
   */
  private reward: MiniBossWinReward | null = null;

  /** Injected storage adapter, or `undefined` for the store's default. */
  private storage: HangarWarStorage | null | undefined;

  /** Authored ring definitions in use (shipped table unless injected). */
  private definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS;

  /** Whether the attract traversal is driving this screen. */
  private demo = false;

  /** Demo dwell override (production uses the shared traversal dwell). */
  private demoDwellMs?: number;

  /** The rendered report (rebuilt on create only). */
  private view: DefenceReportView | null = null;

  /** The demo auto-continue timer, cleared on shutdown. */
  private demoTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super(DEFENCE_REPORT_SCENE_KEY);
  }

  init(data?: DefenceReportSceneData | null): void {
    this.storage = data?.storage;
    this.definitions = data?.definitions ?? HEX_RING_DEFINITIONS;
    this.demo = data?.demo === true;
    this.demoDwellMs = data?.demoDwellMs;
    this.won = data?.won ?? null;
    this.score = data?.score ?? 0;
    this.reward = data?.reward ?? null;

    const injected = data?.payload;
    const loaded = injected ?? this.loadPayload();
    this.payload = materialiseRing(loaded, this.definitions);

    // A direct boot (no record) reports a quiet tick at the payload's own
    // clock position, so the screen always renders something legible.
    this.record = data?.record ?? {
      tick: this.payload.frontierTick ?? 0,
      playerStrength: 0,
      aggressionBudget: 0,
      beatableCeiling: 0,
      deltas: [],
      rose: 0,
      fell: 0,
      attacks: [],
    };
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

  /** (Re)renders the report from the current payload and tick record. */
  private build(): void {
    this.view?.destroy();
    this.view = null;
    const model = buildDefenceReport(this.payload, this.record);
    this.view = renderDefenceReport(this, model, {
      onContinue: () => this.continueToMap(),
    }, { runLine: this.runLine() });
  }

  /** The finished deployment's result line, or `null` when not supplied. */
  private runLine(): string | null {
    if (this.won === null) return null;
    return `${this.won ? 'RUN: VICTORY' : 'RUN: DEFEAT'} · score ${this.score}`;
  }

  /**
   * Continues towards the hex map, carrying this report's war payload so the
   * map shows the same state the tick produced.
   *
   * A winning deployment carries a resolved mini-boss reward (producer Q2 = b):
   * the first activation presents that reward, and the map is reached only
   * after it resolves. With no reward (a loss, or the arcade run) this goes
   * straight to the map, unchanged.
   */
  continueToMap(): void {
    if (this.reward !== null) {
      this._presentReward();
      return;
    }
    this._startMap();
  }

  /** Starts the hex map with this report's war state. */
  private _startMap(): void {
    this.scene.start(HEX_MAP_SCENE_KEY, {
      payload: this.payload,
      storage: this.storage,
      definitions: this.definitions,
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
    });
  }

  /**
   * Presents the carried mini-boss reward, then continues to the map.
   *
   * The reward is the **shipped** overlay — `MiniBossWheelScene` for the wheel,
   * or the shared three-option choice overlay for the empty-owned fallback —
   * launched with the wedges/outcome the run resolved, so one overlay
   * implementation serves both the arcade in-run reward and this win-path
   * reveal (no second reward screen, no duplicated wheel logic). The report is
   * paused while the modal overlay runs, exactly like the in-run reward.
   *
   * A boot without the overlay registered (headless test, misconfig) must not
   * stall on a surface it can never show: it continues to the map instead.
   */
  private _presentReward(): void {
    const reward = this.reward;
    if (reward === null) return;
    // Consume the reward: it is presented exactly once.
    this.reward = null;
    this.demoTimer?.remove(false);
    this.demoTimer = null;

    const overlayKey =
      reward.kind === 'wheel'
        ? MINI_BOSS_WHEEL_SCENE_KEY
        : MINERAL_CHOICE_SCENE_KEY;
    if (!this.scene.manager.getScene(overlayKey)) {
      this._startMap();
      return;
    }

    // Demo/attract mode auto-resolves the overlay so the traversal cannot
    // stall on it; normal play waits for the player.
    const autoMs = this.demo
      ? this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS
      : 0;

    this.scene.pause();
    if (reward.kind === 'wheel') {
      this.scene.launch(MINI_BOSS_WHEEL_SCENE_KEY, {
        origin: 'DefenceReportScene-miniBoss',
        wedges: reward.wedges,
        outcome: reward.outcome,
        ...(autoMs > 0 ? { autoSpinMs: autoMs } : {}),
        // Single overlay contract: the report resumes and continues once the
        // wheel lands. The outcome was already applied to the run at defeat.
        onResult: () => this._afterReward(),
      });
      return;
    }

    this.scene.launch(MINERAL_CHOICE_SCENE_KEY, {
      origin: 'DefenceReportScene-miniBoss',
      options: [...reward.options],
      ...(autoMs > 0 ? { autoSelectMs: autoMs } : {}),
      onSelect: () => this._afterReward(),
    });
  }

  /** Resumes the report after its reward overlay resolved and continues. */
  private _afterReward(): void {
    this.scene.resume();
    this._startMap();
  }

  /**
   * Schedules the attract traversal's single step: continue to the map.
   *
   * The decision itself is the pure, tested `decideReportAction()`, so the
   * scene owns no bot rule — only the dwell that applies it.
   */
  private scheduleDemoAdvance(): void {
    this.demoTimer?.remove(false);
    const dwell = this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS;
    this.demoTimer = this.time.delayedCall(dwell, () => {
      // Guard: only advance while this report is still the active scene.
      if (!this.sys.isActive()) return;
      const action = decideReportAction();
      if (action.kind === 'continueToMap') this.continueToMap();
    });
  }

  // ── Public query seams (tests use these) ────────────────────────

  /** The pure report model currently rendered. */
  getModel(): DefenceReportModel {
    return (
      this.view?.model ??
      buildDefenceReport(this.payload, this.record)
    );
  }

  /** Every rendered row, in reading order. */
  getRows(): readonly DefenceReportRow[] {
    return this.view?.rows ?? [];
  }

  /** The tick record being reported (a detached copy). */
  getRecord(): FrontierTickRecord {
    return JSON.parse(JSON.stringify(this.record)) as FrontierTickRecord;
  }

  /** The payload the report was generated from (a detached copy). */
  getPayload(): HangarWarPayload {
    return JSON.parse(JSON.stringify(this.payload)) as HangarWarPayload;
  }

  /** Whether the attract traversal is driving this screen. */
  isDemo(): boolean {
    return this.demo;
  }

  /**
   * The mini-boss reward still waiting to be presented, or `null` once it has
   * been shown (or when none was carried). A test/inspection seam.
   */
  getReward(): MiniBossWinReward | null {
    return this.reward;
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
