/**
 * Gym scene — **rhythm** audition of the Euclidean weapon cadence
 * (epic AH-0MVYA1JFK003RLAW, child AH-0MVYA28AC006XMKL).
 *
 * A threat-free gallery that makes the fire cadence legible in one bar: the
 * ship carries the six **canonical superposition voices** at their level-0
 * ladder rungs and auto-fires them through the **shared scheduler** — the
 * inherited `CombatCoreScene._tickPlayer` → `Player.tryFire` path the game
 * uses. Nothing about the cadence is re-implemented here: the scene only
 *
 * - activates the canonical cast (`heavy_slug E(1,16)`, `railgun E(2,16)`,
 *   `cannon E(9,16)`, `arc E(4,16 rot 4)`, `rapid E(13,16)`,
 *   `shard_swarm E(2,16)` — the documented fixture in `docs/BALANCING.md`),
 * - renders the **onset stack** the shared scheduler resolves: for every
 *   voice it reads the live `Player.getFirePattern` and expands the tile with
 *   the pure `euclidPattern` generator, so the grid is the shipped pattern
 *   data, not a copy of it,
 * - records every fire the shared path emits (`onWeaponFired`) with the beat
 *   clock's own attributed onset tick (`Player.getLastShotTime`), so every
 *   onset in the gym is provably an exact tick of the same lattice the game
 *   fires on.
 *
 * The resulting sixteen-step bar auditions **slow + medium + fast**
 * superposition: three sparse voices (1, 2 and 2 onsets), one medium voice
 * (4 onsets) and two dense voices (9 and 13) — **31 onsets per bar**, matching
 * the canonical fixture. Onsets are uneven by design; the lattice is the
 * scheduling grid, never a metronome. The level-0 cadence trim
 * (AH-0MW23FEDK006BRHK) moved the fixture from 46 to 31 onsets: the arc left
 * the shared `E(9,16)` rung for a straight one-shot-per-beat rung and the
 * shard swarm's cadence lever was cut to `E(2,16)` while it kept its five-shard
 * fan.
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention.
 *
 * Scripted-scene setup (AH-0MVRMHYJR000Y9H8): the scene consumes the shared
 * `applySceneSetup` applier through `_adoptCaptureSetup`, so a capture setup's
 * power-up levels, heading and determinism seed are live before the first
 * captured frame. The six canonical voices are the audition's fixed cast: a
 * setup may select/level them (`setup.player.weapons` / `weaponLevels`) and
 * any additional setup weapon sounds as an extra voice, but the canonical six
 * are always present so the documented superposition is what the gym shows.
 * The onset grid itself has no scenario knobs — it is the shipped cadence.
 *
 * @module src/scenes/gym/GymRhythm
 */

import Phaser from 'phaser';

import {
  CombatCoreScene,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from '../core/CombatCoreScene';
import { gymBackgroundLevel } from './core/gymBackground';
import type { SceneSetupState } from '../core/sceneSetup';
import { Player } from '../../entities/Player';
import { advancePlayerBullets } from '../core/bulletLifecycle';
import { WeaponId, WEAPON_CATALOGUE } from '../../utils/weapons';
import { playWeaponFireSound } from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import { addHelpButton } from '../../utils/gymHelp';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { SIXTEENTH_NOTE_SUBDIVISIONS } from '../../utils/beat';
import {
  euclidPattern,
  euclidStepMs,
  stepIndexAt,
} from '../../utils/euclid';
import type { EuclideanPattern } from '../../utils/weaponLevels';

/** Steps in one fire bar: four beats of four sixteenth notes (16). */
export const GYM_RHYTHM_BAR_STEPS = SIXTEENTH_NOTE_SUBDIVISIONS * 4;

/** Audition role of a voice, by onsets per bar. */
export type RhythmVoiceRole = 'slow' | 'medium' | 'fast';

/** One canonical voice of the audition: a weapon and its role in the groove. */
export interface RhythmVoice {
  /** The weapon the voice plays. */
  readonly weaponId: WeaponId;
  /** Its role in the superposition (sparse / medium / dense). */
  readonly role: RhythmVoiceRole;
}

/**
 * The six canonical superposition voices, in ascending onsets-per-bar order.
 * These are the epic's agreed level-0 fixture (`docs/BALANCING.md`
 * § Euclidean cadence ladder): 1 + 2 + 2 + 4 + 9 + 13 = 31 onsets per bar.
 */
export const GYM_RHYTHM_VOICES: readonly RhythmVoice[] = Object.freeze([
  Object.freeze({ weaponId: 'heavy_slug', role: 'slow' }),
  Object.freeze({ weaponId: 'railgun', role: 'slow' }),
  Object.freeze({ weaponId: 'shard_swarm', role: 'slow' }),
  Object.freeze({ weaponId: 'arc', role: 'medium' }),
  Object.freeze({ weaponId: 'cannon', role: 'fast' }),
  Object.freeze({ weaponId: 'rapid', role: 'fast' }),
]);

/** Total onsets the canonical six voices contribute to one 16-step bar. */
export const GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR = 31;

/** Hint line shown at the top of the gym. */
export const GYM_RHYTHM_HINT =
  'Rhythm — six Euclidean voices on the shared 16-step lattice (80 BPM)';

/** Bounded fire-event history kept for the overlay and tests. */
export const GYM_RHYTHM_MAX_FIRE_EVENTS = 512;

/** One fire the shared scheduler emitted, attributed to its onset tick. */
export interface RhythmFireEvent {
  /** The voice that fired. */
  readonly weaponId: WeaponId;
  /** The onset tick the shared scheduler attributed the shot to (ms). */
  readonly shotTime: number;
  /** Bar the onset belongs to (bar 0 starts at the lattice anchor). */
  readonly bar: number;
  /** Step inside the bar (`0 … GYM_RHYTHM_BAR_STEPS - 1`). */
  readonly step: number;
}

/** Onset stack: for every step of the bar, the voices that sound on it. */
export type RhythmOnsetStack = readonly (readonly WeaponId[])[];

/** Grid geometry (px). The sixteen cells span the screen below the ship. */
const GRID_X = 232;
const GRID_Y = 300;
const CELL_W = 42;
const ROW_H = 24;
const DOT_RADIUS = 5;
const FLASH_DECAY_PER_SECOND = 4;

/** Voice colours by role: cold sparse, warm medium, hot dense. */
const ROLE_COLOURS: Readonly<Record<RhythmVoiceRole, number>> = {
  slow: 0x66ccff,
  medium: 0xffd166,
  fast: 0xff6b9d,
};

/** Text style shared by the overlay labels. */
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#dddddd',
};

/**
 * Rhythm gym. Extends the shared {@link CombatCoreScene} so the player step,
 * the beat clock and auto-fire (`_tickPlayer` → `Player.tryFire`) are the one
 * shipped implementation the game runs; the scene only auditions and
 * visualises what that scheduler resolves.
 */
export class GymRhythm extends CombatCoreScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  never
> {
  private player: Player | null = null;
  /** Bounded history of fires emitted by the shared scheduler. */
  private firedEvents: RhythmFireEvent[] = [];
  /** Per-voice overlay flash level, decaying after each fire. */
  private fireFlashes = new Map<WeaponId, number>();
  private panel: Phaser.GameObjects.Graphics | null = null;
  private labels: Phaser.GameObjects.Text[] = [];

  constructor() {
    super({ key: 'GymRhythm' });
  }

  /** Gym family background decision: fixed representative level, no warp. */
  protected override backgroundLevel(): number | null {
    return gymBackgroundLevel();
  }

  create(data?: SceneSetupState): void {
    this.resetRunState();
    // Shared background layer at the gym family's pinned level (see
    // `core/gymBackground.ts`, AH-0MVSEC0J0004YNJC).
    this._createSceneBackground();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: 150,
    });
    this.add.existing(this.player);

    // Scripted-scene setup (AH-0MVRMHYJR000Y9H8): power-up levels, heading
    // and the determinism seed are live before the first captured frame. A
    // setup may grant voices and levels; the canonical cast is completed
    // below so the audition always plays the documented superposition.
    this._adoptCaptureSetup(data);
    this._equipCanonicalCast();

    addBackToIndexButton(this);
    addHelpButton(this, {
      gymKey: 'GymRhythm',
      drops: GYM_RHYTHM_VOICES.map((voice) => voice.weaponId),
    });
    addBackToMenuOnEsc(this);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as WasdKeysLike | undefined;

    this.add.text(24, 20, GYM_RHYTHM_HINT, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#88ffcc',
    });
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 18, this._legendLine(), {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#888888',
    }).setOrigin(0.5, 1);

    this.panel = this.add.graphics();
    for (const [index, voice] of GYM_RHYTHM_VOICES.entries()) {
      const entry = WEAPON_CATALOGUE[voice.weaponId];
      this.labels.push(
        this.add.text(
          24,
          GRID_Y + index * ROW_H + ROW_H / 2 - 6,
          `${entry.name} · ${voice.role}`,
          { ...LABEL_STYLE, color: `#${ROLE_COLOURS[voice.role]
            .toString(16)
            .padStart(6, '0')}` },
        ),
      );
    }
    this._drawPanel();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.teardownRunState(),
    );
  }

  /** Resets shared per-run state plus this gym's history and overlay. */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.firedEvents = [];
    this.fireFlashes = new Map();
    this.panel = null;
    this.labels = [];
  }

  /** Destroys the scene-owned player and overlay on `SHUTDOWN`. */
  protected override teardownRunState(): void {
    super.teardownRunState();
    this.player?.destroy();
    this.player = null;
    this.panel?.destroy();
    this.panel = null;
    for (const label of this.labels) label.destroy();
    this.labels = [];
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds): the shared player step
   * (input → physics → auto-fire), the shared bullet lifecycle and the
   * overlay refresh. Used by the scene loop and by tests.
   */
  tick(dt: number): void {
    if (!this.player) return;
    this._tickPlayer(dt);
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);
    this._decayFireFlashes(dt);
    this._drawPanel();
  }

  // ── Canonical cast ───────────────────────────────────────────────

  /**
   * Grants the canonical cast permanently, once. A weapon the capture setup
   * already granted keeps its setup level (the first grant is the base rung,
   * so a setup listing the six yields the documented level-0 fixture); the
   * permanent cannon is always present and is never re-granted.
   */
  private _equipCanonicalCast(): void {
    const player = this.player;
    if (!player) return;
    for (const voice of GYM_RHYTHM_VOICES) {
      if (player.hasWeapon(voice.weaponId)) continue;
      player.equipWeapon(voice.weaponId, true);
    }
  }

  // ── Shared scheduler observation ─────────────────────────────────

  /**
   * Shared auto-fire hook: records the fire with the onset tick the scheduler
   * attributed it to (`Player.getLastShotTime` — always an exact lattice tick)
   * and plays the shared per-weapon fire cue. No scheduling happens here.
   */
  protected override onWeaponFired(weaponId: WeaponId): void {
    playWeaponFireSound(weaponId);
    const player = this.player;
    if (!player) return;
    const shotTime = player.getLastShotTime(weaponId);
    if (shotTime === undefined) return;
    const { stepMs, anchorMs } = this._lattice();
    const index = stepIndexAt(shotTime, stepMs, anchorMs);
    const bar = Math.floor(index / GYM_RHYTHM_BAR_STEPS);
    const step =
      ((index % GYM_RHYTHM_BAR_STEPS) + GYM_RHYTHM_BAR_STEPS) %
      GYM_RHYTHM_BAR_STEPS;
    this.firedEvents.push({ weaponId, shotTime, bar, step });
    if (this.firedEvents.length > GYM_RHYTHM_MAX_FIRE_EVENTS) {
      this.firedEvents.shift();
    }
    this.fireFlashes.set(weaponId, 1);
  }

  /** The live lattice a voice is scheduled on (shared step + clock anchor). */
  private _lattice(): { stepMs: number; anchorMs: number } {
    const player = this.player;
    const pattern = player?.getFirePattern(GYM_RHYTHM_VOICES[0].weaponId);
    return {
      stepMs: pattern?.stepMs ?? euclidStepMs(),
      anchorMs: player?.getBeatClock().anchorMs ?? 0,
    };
  }

  /**
   * The live pattern the shared scheduler is playing for one voice, as
   * `{ k, n, rotation, stepMs }`, or `undefined` when the voice is inactive.
   */
  getVoicePattern(weaponId: WeaponId): EuclideanPattern | undefined {
    return this.player?.getFirePattern(weaponId);
  }

  /**
   * The onset stack the shared scheduler resolved for the current patterns:
   * for every step of the bar, the canonical voices that sound on it. Read
   * from the live `Player.getFirePattern` data and expanded with the shared
   * pure `euclidPattern` generator, so the gym cannot drift from the cadence.
   */
  getOnsetStack(): RhythmOnsetStack {
    const stack: WeaponId[][] = Array.from(
      { length: GYM_RHYTHM_BAR_STEPS },
      () => [],
    );
    for (const voice of GYM_RHYTHM_VOICES) {
      const pattern = this.getVoicePattern(voice.weaponId);
      if (!pattern) continue;
      const tile = euclidPattern(pattern.k, pattern.n, pattern.rotation);
      for (let step = 0; step < GYM_RHYTHM_BAR_STEPS; step += 1) {
        if (tile.onsets.includes(step % tile.n)) {
          stack[step].push(voice.weaponId);
        }
      }
    }
    return stack;
  }

  /** Total onsets the live stack places in one bar. */
  getBarOnsetTotal(): number {
    return this.getOnsetStack().reduce((total, voices) => total + voices.length, 0);
  }

  /** The bar step the shared beat clock is currently on (`0 … 15`). */
  getBarStep(): number {
    const player = this.player;
    if (!player) return 0;
    const { stepMs, anchorMs } = this._lattice();
    const index = stepIndexAt(player.getBeatClock().now(), stepMs, anchorMs);
    return ((index % GYM_RHYTHM_BAR_STEPS) + GYM_RHYTHM_BAR_STEPS) % GYM_RHYTHM_BAR_STEPS;
  }

  /** A copy of the bounded fire-event history (oldest first). */
  getFiredEvents(): readonly RhythmFireEvent[] {
    return [...this.firedEvents];
  }

  /** Public player accessor (test seam and shared tests). */
  getPlayer(): Player | null {
    return this.player;
  }

  // ── Overlay ──────────────────────────────────────────────────────

  private _legendLine(): string {
    return `canonical ${GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR} onsets / bar · playhead = shared beat clock`;
  }

  private _decayFireFlashes(dt: number): void {
    const decay = dt * FLASH_DECAY_PER_SECOND;
    for (const [weaponId, level] of [...this.fireFlashes.entries()]) {
      const next = level - decay;
      if (next <= 0) this.fireFlashes.delete(weaponId);
      else this.fireFlashes.set(weaponId, next);
    }
  }

  /** Redraws the onset grid, the playhead column and the fire flashes. */
  private _drawPanel(): void {
    const panel = this.panel;
    if (!panel) return;
    panel.clear();

    const playhead = this.getBarStep();
    const gridHeight = GYM_RHYTHM_VOICES.length * ROW_H;
    // Playhead column behind the dots.
    panel.fillStyle(0xffffff, 0.08);
    panel.fillRect(GRID_X + playhead * CELL_W, GRID_Y - 4, CELL_W, gridHeight + 8);

    const stack = this.getOnsetStack();
    for (const [row, voice] of GYM_RHYTHM_VOICES.entries()) {
      const colour = ROLE_COLOURS[voice.role];
      const y = GRID_Y + row * ROW_H + ROW_H / 2;
      // Row baseline so an empty voice row still reads as part of the grid.
      panel.lineStyle(1, colour, 0.2);
      panel.lineBetween(
        GRID_X + 4,
        y + DOT_RADIUS + 5,
        GRID_X + GYM_RHYTHM_BAR_STEPS * CELL_W - 4,
        y + DOT_RADIUS + 5,
      );
      for (let step = 0; step < GYM_RHYTHM_BAR_STEPS; step += 1) {
        const x = GRID_X + step * CELL_W + CELL_W / 2;
        panel.fillStyle(colour, 0.12);
        panel.fillCircle(x, y, DOT_RADIUS + 2);
        if (stack[step].includes(voice.weaponId)) {
          panel.fillStyle(colour, step === 0 ? 1 : 0.85);
          panel.fillCircle(x, y, DOT_RADIUS);
        }
      }
      const flash = this.fireFlashes.get(voice.weaponId) ?? 0;
      if (flash > 0) {
        const x = GRID_X + playhead * CELL_W + CELL_W / 2;
        panel.lineStyle(2, 0xffffff, flash);
        panel.strokeCircle(x, y, DOT_RADIUS + 4 + (1 - flash) * 6);
      }
    }
  }
}
