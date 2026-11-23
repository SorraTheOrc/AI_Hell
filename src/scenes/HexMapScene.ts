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
 * goes **through the ship-config screen**: activating an unheld hex opens
 * `HangarScene` pre-targeted at it, and that screen's `▶ DEPLOY` launches the
 * shipped deployment path (`./hangarWar/hangarDeployment` → `PlayScene` with
 * the hangar loadout and the hex-aggression difficulty). So the map starts no
 * battle itself, introduces no second deployment rule and never touches the
 * arcade checkpoint (parent AH-0MWMRWCY2001HWGR AC1).
 *
 * The config screen repeats this map's known-ahead intel where the player
 * commits: a `TARGET INTEL` block names the chosen hex's boss and its authored
 * strengths/weaknesses, and every weapon row carries an `▲ EFFECTIVE` /
 * `▼ RESISTED` matchup mark against that boss. All of it is **display only**
 * (AH-0MWMT4STK001PSK4) — the mechanical matchup is AH-0MWL5376H001WJFZ's — and
 * `GymHangar` renders the same shared model read-only, so the two surfaces
 * cannot drift.
 *
 * Navigation: activating an **unheld** hex opens the config screen for it
 * (`openConfig`); the `◀ HANGAR` row opens `HangarScene` with no target (one
 * click, the design's "what I own" and "what I hold" one click apart); ESC
 * returns to the main menu. The payload can be injected as launch data
 * (`{ payload, storage, definitions }`) so tests and the capture tooling boot a
 * deterministic war without touching `localStorage`.
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
 * ## The post-battle results dialog (`AH-0MWMGPV420013MGB`)
 *
 * A deployment landing also carries a compact **sortie result**
 * (`sortieResult`: the target hex id, `won`/`score`, the win path's own
 * `HexCaptureResult` fields and the loss path's `forfeited` salvage). When one
 * is carried the map presents the **results dialog** (`HexCombatResultScene`)
 * over the paused map as its very first act — before any carried mini-boss
 * reward and before the demo dwell is scheduled — so neither the reward nor the
 * attract traversal can skip past it. The dialog's title and rows are the pure
 * `buildSortieResultView` output (`src/core/hangarWar/sortieResult.ts`); the
 * scene derives no reward, score or weakness of its own.
 *
 * One confirm input dismisses it (the overlay owns the input contract); the map
 * resumes and then hands over to any carried reward and, once that resolves, to
 * the demo dwell. While a sortie result is carried the thin run line and the
 * banked win-bonus line are **folded into the dialog** rather than drawn twice
 * (parent assumption A1): the outcome, score and every paid reward — the win
 * bonus included — are dialog rows. The `RING WON` / `HANGAR FALLS` assault
 * banner is a distinct surface and is unchanged.
 *
 * ## The hangar assault announcement (`AH-0MWEZZA4E0081NJ5`)
 *
 * A landing may also carry the **resolved ring-end hangar assault** the
 * deployment's capture ran (`assault`). The map's model copies the report
 * model's own section into `assault` / `assaultLine` / `ringWon` /
 * `campaignReset`, and the shared renderer draws it as a read-only banner: a
 * repel announces the ring won (and the next ring opening), a fall announces
 * the hangar-falls **full campaign reset**. Because the banner adds no action,
 * the attract traversal keeps its one total next step (deploy, or the hangar
 * once secured) and cannot stall on it.
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
import type {
  FrontierTickRecord,
  HangarAssaultResolution,
} from '../core/hangarWar/hexDefence';
import {
  buildHexMapModel,
  type HexMapModel,
} from '../core/hangarWar/hexIntel';
import type { SortieResultRecord } from '../core/hangarWar/sortieResult';
import { buildSortieResultView } from '../core/hangarWar/sortieResult';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  decideMapAction,
  HANGAR_WAR_TRAVERSAL_DWELL_MS,
} from '../ai/hangarWarTraversal';
import type { MiniBossWinReward } from '../powerups/miniBossWheel';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import { BOT_UPGRADE_SCENE_KEY } from './BotUpgradeScene';
import { HEX_COMBAT_RESULT_SCENE_KEY } from './HexCombatResultScene';
import { HANGAR_SCENE_KEY } from './HangarScene';
import { MINI_BOSS_WHEEL_SCENE_KEY } from './MiniBossWheelScene';
import {
  renderHexMap,
  type HexMapArrow,
  type HexMapRow,
  type HexMapSection,
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
   * The resolved ring-end hangar assault the deployment's capture ran
   * (`AH-0MWEZZA4E0081NJ5`), or omitted/`null` when it ran none. Transient
   * launch data: the map announces the ring win or the hangar-falls campaign
   * reset from this record and never persists it.
   */
  assault?: HangarAssaultResolution | null;
  /**
   * The fixed mineral **win bonus** this landing banked, or omitted/`0` when it
   * banked none (parent AH-0MWEVNBMM000QFO2, producer Q3 = (b), recorded
   * 2026-11-13). It is the win path's whole reward presentation now: the map
   * announces the banked bonus instead of presenting the run-scoped wheel the
   * winning path no longer carries.
   */
  winBonusMinerals?: number;
  /**
   * The mini-boss reward a winning deployment resolved and carried here
   * (parent AH-0MWBW1B1Z0059CC2). Presented over the **paused** map through the
   * shipped overlay and consumed exactly once; `null`/omitted on a loss, so the
   * map is interactive immediately.
   */
  reward?: MiniBossWinReward | null;
  /**
   * The finished deployment's sortie result record (the target hex id plus
   * the win path's capture fields or the loss path's forfeited salvage).
   * Transient launch data: never persisted, so a later menu/hangar entry
   * carries none.
   */
  sortieResult?: SortieResultRecord | null;
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
   * The resolved hangar assault this landing followed, or `null` when the
   * deployment's capture ran none. Transient launch data, never persisted.
   */
  private assault: HangarAssaultResolution | null = null;
  /** The banked win bonus announced on this landing (0 = none). */
  private winBonusMinerals = 0;

  /**
   * The resolved mini-boss reward carried by this landing, or `null` when there
   * is none (a loss, a plain entry, or once it has been presented). Consumed
   * exactly once.
   */
  private reward: MiniBossWinReward | null = null;

  /**
   * The sortie result carried by this landing, or `null` when none was
   * supplied (a plain entry, or after the results dialog has been dismissed).
   * Transient launch data only: never persisted.
   */
  private sortieResult: SortieResultRecord | null = null;

  /**
   * True once the carried sortie result has been presented. The result is
   * presented exactly once, so no second presentation path can re-show it
   * (the shipped `presentReward()` consume-once rule).
   */
  private resultsPresented = false;

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
    this.assault = data?.assault ?? null;
    this.winBonusMinerals = data?.winBonusMinerals ?? 0;
    this.reward = data?.reward ?? null;
    this.sortieResult = data?.sortieResult ?? null;
    this.resultsPresented = false;
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
    // The post-battle results dialog goes first (AH-0MWMGPV420013MGB): it
    // summarises the finished deployment over the paused map before any
    // carried mini-boss reward and before the demo dwell is scheduled, so
    // neither the reward overlay nor the attract traversal can skip past it.
    // A boot without the overlay registered keeps the map live and falls
    // through to the shipped reward/dwell rules.
    if (this.presentResults()) return;
    // A carried mini-boss reward is presented over the paused map first; the
    // demo dwell (which would deploy from the map) only starts once it is
    // resolved, so the traversal cannot skip past the reward.
    if (this.reward !== null) {
      this.presentReward();
      return;
    }
    if (this.demo) this.scheduleDemoAdvance();
  }

  /**
   * Returns a detached copy of the carried sortie result, or `null` when none
   * was supplied (a plain menu/hangar entry). Never returns the live internal
   * reference.
   */
  getSortieResult(): SortieResultRecord | null {
    return this.sortieResult
      ? (JSON.parse(JSON.stringify(this.sortieResult)) as SortieResultRecord)
      : null;
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
      assault: this.assault,
      winBonusMinerals: this.displayWinBonus(),
    });
    this.view = renderHexMap(this, model, {
      onDeploy: (hexId) => this.openConfig(hexId),
      onOpenHangar: () => this.openHangar(),
      // A demo is a demonstration, not progress: the attract traversal never
      // triggers the upgrade action and it must never reach a persisting
      // screen, so the handler is omitted under demo (the row renders
      // non-actionable) — the same rule the hangar's restart/save rows follow.
      ...(this.demo
        ? {}
        : { onUpgradeDefences: (hexId: string) => this.openBotUpgrade(hexId) }),
    }, { runLine: this.runLine() });
  }

  /**
   * The finished deployment's result line, or `null` when this landing carried
   * no result (a plain menu/hangar entry) or when the results dialog is
   * carrying it. Transient launch data.
   *
   * On a deployment landing the sortie result is drawn by the results dialog —
   * the outcome and score are its first row — so the thin run line is **folded
   * into the dialog** rather than drawn a second time (parent assumption A1).
   */
  private runLine(): string | null {
    if (this.sortieResult !== null) return null;
    if (this.won === null) return null;
    return `${this.won ? 'RUN: VICTORY' : 'RUN: DEFEAT'} · score ${this.score}`;
  }

  /**
   * The win bonus the map's model announces, or `0` when the results dialog is
   * carrying it.
   *
   * The dialog lists every paid reward, the banked win bonus included
   * (parent assumption A1), so drawing the model's own `WIN BONUS BANKED` line
   * as well would show the same fact twice on one landing.
   */
  private displayWinBonus(): number {
    return this.sortieResult === null ? this.winBonusMinerals : 0;
  }

  /**
   * Opens the ship-config (hangar) screen **pre-targeted at `hexId`**
   * (parent AH-0MWMRWCY2001HWGR AC1; this item AH-0MWMT4S5U001EGDF).
   *
   * The map's hex activation (and the attract traversal's `deploy` decision)
   * route through here instead of starting `PlayScene`, so **no hex battle can
   * begin without the config screen first**: the player reads the target boss's
   * intel, picks a loadout, and that screen's `▶ DEPLOY` row launches the
   * deployment at the same hex. The map's current war state is handed over, so
   * both screens show one payload — including one injected by a test or the
   * attract traversal, which the versioned store never sees.
   *
   * @param hexId — the hex the config screen targets and deploys at.
   */
  openConfig(hexId: string): void {
    this.scene.start(HANGAR_SCENE_KEY, {
      payload: this.payload,
      storage: this.storage,
      demo: this.demo,
      demoDwellMs: this.demoDwellMs,
      targetHexId: hexId,
    });
  }

  /**
   * Opens the bot-upgrade screen scoped to the defender of held `hexId`
   * (parent AH-0MWH48IEG00929GQ). The map's payload is handed over, so both
   * screens read and write one war state; a purchase persists from there and
   * returns to this map.
   *
   * @param hexId — the held hex whose defending bot is upgraded.
   */
  openBotUpgrade(hexId: string): void {
    this.scene.start(BOT_UPGRADE_SCENE_KEY, {
      payload: this.payload,
      storage: this.storage,
      hexId,
    });
  }

  /**
   * Opens the hangar screen with **no** carried target (the `◀ HANGAR` row),
   * carrying the map's payload so what the player sees on both screens is one
   * war state. Its `▶ DEPLOY` therefore keeps the shipped default — the
   * weakest unheld hex via `selectDeploymentHex` — so a menu/hangar entry
   * targets exactly what it would have launched before the config hop.
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
   * Presents the carried sortie result as the post-battle **results dialog**
   * over the paused map, or does nothing when none is pending
   * (AH-0MWMGPV420013MGB, child of AH-0MWMFGXD6005WTMN).
   *
   * The dialog's title and rows are the pure `buildSortieResultView` output
   * (the target hex's authored boss intel is read there, never here), so this
   * scene derives no reward, score, weakness or rule — it pauses itself at the
   * `SceneManager` level and hands the view over, exactly like the shipped
   * `presentReward()` overlay. Dismissal resumes the map and hands over to any
   * carried mini-boss reward and then the demo dwell.
   *
   * The result is consumed (presented) exactly once, so a second presentation
   * path cannot re-show it. A boot without the overlay registered (headless
   * test, misconfiguration) must not stall on a surface it can never show: the
   * result is consumed and the map stays interactive.
   *
   * @returns whether a pending sortie result was consumed by this call.
   */
  presentResults(): boolean {
    const record = this.sortieResult;
    if (record === null || this.resultsPresented) return false;
    // Consume the result: it is presented exactly once.
    this.resultsPresented = true;
    if (!this.scene.manager.getScene(HEX_COMBAT_RESULT_SCENE_KEY)) {
      // Nothing to present the results with: keep the map live (and the demo
      // traversal moving) rather than pausing on a screen that cannot exist.
      return false;
    }

    // The demo dwell is suspended while the dialog waits, so the attract
    // traversal cannot act behind it; the overlay auto-confirms after that
    // same dwell so the traversal cannot stall on it either.
    this.demoTimer?.remove(false);
    this.demoTimer = null;
    const autoMs = this.demo
      ? this.demoDwellMs ?? HANGAR_WAR_TRAVERSAL_DWELL_MS
      : 0;

    const view = buildSortieResultView(record, this.definitions);
    this.scene.pause();
    this.scene.launch(HEX_COMBAT_RESULT_SCENE_KEY, {
      origin: 'HexMapScene-sortieResult',
      view,
      onDismiss: () => this.afterResults(),
      ...(autoMs > 0 ? { autoDismissMs: autoMs } : {}),
    });
    return true;
  }

  /**
   * Resumes the map after the results dialog resolved, then hands over to any
   * carried mini-boss reward — the results dialog always comes first, so the
   * order is deterministic — and finally to the demo dwell (so the attract
   * traversal continues from the map rather than stalling).
   */
  private afterResults(): void {
    this.scene.resume();
    if (this.reward !== null) {
      this.presentReward();
      return;
    }
    if (this.demo) this.scheduleDemoAdvance();
  }

  /**
   * Whether the results dialog is on screen (its scene is running above this
   * paused map).
   */
  isResultsVisible(): boolean {
    const dialog = this.scene.manager.getScene(HEX_COMBAT_RESULT_SCENE_KEY);
    return dialog !== null && dialog !== undefined && dialog.sys.isActive();
  }

  /**
   * The results dialog's rendered text — its heading plus every row, in draw
   * order — or `''` when the dialog is not on screen. A test/inspection seam
   * over the dialog's own report, never a second rendering rule.
   */
  getResultsText(): string {
    if (!this.isResultsVisible()) return '';
    const dialog = this.scene.manager.getScene(HEX_COMBAT_RESULT_SCENE_KEY) as
      | (Phaser.Scene & {
          getTitle?: () => string;
          getRows?: () => string[];
        })
      | null;
    if (dialog === null) return '';
    const title = typeof dialog.getTitle === 'function' ? dialog.getTitle() : '';
    const rows = typeof dialog.getRows === 'function' ? dialog.getRows() : [];
    return [title, ...rows].filter((line) => line.length > 0).join('\n');
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
        // The bot opens the config screen for the chosen hex; that screen's
        // own bounded demo advance deploys at the carried target, so the
        // traversal walks map → config → deployment without stalling.
        this.openConfig(action.hexId);
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
        assault: this.assault,
        winBonusMinerals: this.displayWinBonus(),
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
   * The resolved hangar assault this landing carried (a detached copy), or
   * `null` when the deployment's capture ran none. Never persisted.
   */
  getAssault(): HangarAssaultResolution | null {
    return this.assault === null
      ? null
      : (JSON.parse(
          JSON.stringify(this.assault),
        ) as HangarAssaultResolution);
  }

  /**
   * The rendered hangar-assault announcement (`RING WON …` / `HANGAR FALLS …`
   * plus its arithmetic and consequence), or `''` when none was carried.
   */
  getAssaultText(): string {
    return this.view?.getAssaultText() ?? '';
  }

  /** Whether the hangar-assault announcement is on screen. */
  isAssaultVisible(): boolean {
    return this.view?.isAssaultVisible() ?? false;
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

  /**
   * The banked win-bonus announcement this landing shows
   * (`WIN BONUS BANKED: +N MINERALS`), or `null` when it banked none.
   *
   * The winning hangar deployment's whole reward presentation: the wheel and
   * the empty-owned fallback choice are suppressed on that path and the bonus
   * is banked into the persistent war instead (parent AH-0MWEVNBMM000QFO2,
   * producer Q1 = (c) / Q2 = (a) / Q3 = (b), recorded 2026-11-13).
   */
  getWinBonusLine(): string | null {
    return (
      buildHexMapModel(this.payload, {
        definitions: this.definitions,
        record: this.record,
        assault: this.assault,
        winBonusMinerals: this.displayWinBonus(),
      }).winBonusLine
    );
  }

  /**
   * The banked held-hex income announcement this landing shows
   * (`HEX INCOME BANKED: +N MINERALS`), or `null` when the tick banked nothing
   * (no hex held). Read from the tick record's own `hexIncome` through the map
   * model (AH-0MWL8CDGN005878A), so the map and the report cannot drift.
   */
  getHexIncomeLine(): string | null {
    return (
      buildHexMapModel(this.payload, {
        definitions: this.definitions,
        record: this.record,
        assault: this.assault,
        winBonusMinerals: this.displayWinBonus(),
      }).hexIncomeLine
    );
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
   * The rendered section registry: one `{ key, heading, rect }` per section,
   * in reading order (`last-sortie` only when the landing carries news).
   *
   * Deterministic test seam and the query a caller uses to know the screen's
   * regions; the layout itself lives only in the shared renderer.
   */
  getSections(): readonly HexMapSection[] {
    return this.view?.sections ?? [];
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

  /**
   * The `UPGRADE DEFENCES` action's current text, or `''` when the focused hex
   * offers none (parent AH-0MWH48IEG00929GQ).
   */
  getUpgradeText(): string {
    return this.view?.getUpgradeText() ?? '';
  }

  /** Whether the held-hex `UPGRADE DEFENCES` action is showing. */
  isUpgradeVisible(): boolean {
    return this.view?.isUpgradeVisible() ?? false;
  }

  /** The held hex the `UPGRADE DEFENCES` action targets, or `null`. */
  getUpgradeHexId(): string | null {
    return this.view?.getUpgradeHexId() ?? null;
  }

  /** Activates the held-hex `UPGRADE DEFENCES` action (its pointer path). */
  activateUpgrade(): void {
    this.view?.activateUpgrade();
  }
}
