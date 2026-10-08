/**
 * Game telemetry instrumentation: per-tick state + input and discrete events
 * (AH-0MUY08VVQ007HSSH, child 3 of epic AH-0MUY089KR003F8S4).
 *
 * The generic telemetry framework (`src/telemetry`, AH-0MUY08VJ9006BHJO)
 * deliberately keeps the `state`, `input` and `payload` shapes **opaque** —
 * it owns the framed, versioned envelope, the bounded/batched pipeline and
 * the PII sanitiser. This module owns the **concrete game shape** on top of
 * it and is the single instrumentation layer shared by the shipped
 * `PlayScene` and any gym that opts in (AC4):
 *
 * - {@link buildRunTelemetryState} — a compact, versioned state vector built
 *   from the existing read-only {@link BotSnapshot} (AC1) plus the fields the
 *   snapshot does not carry (player heading, lives, invulnerability, the
 *   mineral hold and the run-scoped weapon/power-up levels).
 * - {@link serialiseTelemetryInput} — the scheme-tagged input actually
 *   applied for the tick (AC2).
 * - {@link RunTelemetry} — a thin, strictly no-op-unless-enabled wrapper over
 *   a {@link TelemetryRecorder} that names the discrete events (AC3) and
 *   tags every state/event with a concrete version (AC6).
 *
 * ## Versioning (AC6)
 *
 * Two versions are in play:
 *
 * 1. The framework's `schemaVersion` is written onto **every** record by the
 *    recorder (see `src/telemetry/schema.ts`). Consumers key migrations off
 *    it.
 * 2. {@link RUN_TELEMETRY_STATE_VERSION} / {@link RUN_TELEMETRY_EVENT_VERSION}
 *    version the **concrete** state and event payload shapes this module
 *    owns, so the payload can evolve independently of the envelope.
 *
 * The per-tick state also carries the run seed ({@link BotSnapshot.runSeed}),
 * so a single tick line is self-describing even when read out of order.
 *
 * ## Disabled by default (AC5)
 *
 * {@link RunTelemetry} checks `recorder.enabled` before doing any work, so a
 * disabled run performs only a boolean check per tick — no snapshots, no
 * serialisation, zero records. The framework's `NoopTelemetryRecorder` is
 * used when telemetry is off.
 *
 * @module scenes/core/runTelemetry
 */

import type { BotSnapshot } from '../../ai/botSnapshot';
import type { ControlInput } from '../../utils/movementModel';
import {
  NoopTelemetryRecorder,
  type TelemetryBuildInfo,
  type TelemetryJson,
  type TelemetryRecorder,
} from '../../telemetry';

/** Concrete state-vector version (AC6); bump on a breaking shape change. */
export const RUN_TELEMETRY_STATE_VERSION = 1;

/** Concrete event-payload version (AC6); bump on a breaking shape change. */
export const RUN_TELEMETRY_EVENT_VERSION = 1;

/**
 * Every discrete event this instrumentation can emit (AC3). Exported as a
 * frozen list so consumers/tests can assert the closed set.
 */
export const RUN_TELEMETRY_EVENTS = [
  /** Run started; payload `{ v, seed }`. */
  'run_start',
  /** Run ended (win or lose); payload `{ v, won, score }`. */
  'run_end',
  /** A hit cost the ship a life; payload `{ v, lives }`. */
  'player_hit',
  /** A shield absorbed a hit (no life lost); payload `{ v }`. */
  'player_hit_absorbed',
  /** The ship ran out of lives; payload `{ v }`. */
  'player_death',
  /** An enemy/asteroid was destroyed; payload `{ v, archetype, x, y }`. */
  'enemy_killed',
  /** A power-up/weapon was collected; payload `{ v, kind, id }`. */
  'pickup',
  /** A mineral was collected into the hold; payload `{ v, total }`. */
  'mineral_collected',
  /** The hold filled and the choice opened; payload `{ v, options }`. */
  'hold_full',
  /** The hold-full choice was resolved; payload `{ v, index, id }`. */
  'choice_selected',
  /** A wave started; payload `{ v, level, waveNumber, waveCount }`. */
  'wave_start',
  /** A wave was cleared; payload `{ v, level, waveNumber }` (the now-current next wave). */
  'wave_cleared',
  /** A level was cleared; payload `{ v, level }` (the now-current next level). */
  'level_cleared',
  /** The campaign triggered the boss encounter; payload `{ v }`. */
  'boss_triggered',
  /** The boss encounter began; payload `{ v }`. */
  'boss_spawn',
  /** The boss advanced a phase; payload `{ v, phase }`. */
  'boss_phase',
  /** The boss was destroyed (victory); payload `{ v }`. */
  'boss_defeated',
] as const;

/** A discriminator from {@link RUN_TELEMETRY_EVENTS}. */
export type RunTelemetryEvent = (typeof RUN_TELEMETRY_EVENTS)[number];

// ── Concrete state vector (AC1) ──────────────────────────────────────

/** Player fields the state vector carries (AC1: position, velocity, heading). */
export interface RunTelemetryPlayer {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /** Ship heading in radians (0 = right, positive = clockwise). */
  readonly heading: number;
  /** Remaining lives. */
  readonly lives: number;
  /** Whether the ship is currently invulnerable after a hit. */
  readonly invulnerable: boolean;
}

/** The mineral hold (AC1: hold). */
export interface RunTelemetryHold {
  readonly minerals: number;
  readonly capacity: number;
}

/** A run-scoped level entry (AC1: levels). */
export interface RunTelemetryLevel {
  readonly id: string;
  readonly level: number;
}

/** The run-scoped weapon/power-up levels (AC1: levels). */
export interface RunTelemetryLevels {
  readonly weapons: readonly RunTelemetryLevel[];
  readonly powerUps: readonly RunTelemetryLevel[];
}

/** The versioned per-tick state vector (AC1). */
export interface RunTelemetryState {
  /** Concrete state-vector version ({@link RUN_TELEMETRY_STATE_VERSION}). */
  readonly v: number;
  /** The per-run RNG seed, so a tick is self-describing (AC6). */
  readonly runSeed: number;
  readonly player: RunTelemetryPlayer | null;
  readonly hold: RunTelemetryHold;
  readonly levels: RunTelemetryLevels;
  readonly enemies: readonly {
    readonly x: number;
    readonly y: number;
    readonly alive: boolean;
    readonly archetype: string;
  }[];
  readonly enemyBullets: readonly {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
  }[];
  readonly drops: readonly {
    readonly x: number;
    readonly y: number;
    readonly type: string;
  }[];
  readonly minerals: readonly {
    readonly x: number;
    readonly y: number;
    readonly type: string;
  }[];
  readonly boss: {
    readonly x: number;
    readonly y: number;
    readonly alive: boolean;
    readonly phase: number;
  } | null;
  readonly aliveCount: number;
  readonly wave: {
    readonly active: boolean;
    readonly timeRemaining: number;
    readonly timeLimit: number;
  } | null;
}

/**
 * The extra, non-snapshot fields the state vector carries (AC1): the read-only
 * {@link BotSnapshot} has position/velocity/enemies/etc, but not the
 * authoritative run state (lives, hold, levels) or the ship heading.
 */
export interface RunTelemetryExtras {
  readonly heading: number;
  readonly lives: number;
  readonly invulnerable: boolean;
  readonly minerals: number;
  readonly mineralCapacity: number;
  readonly weaponLevels: readonly RunTelemetryLevel[];
  readonly powerUpLevels: readonly RunTelemetryLevel[];
}

/**
 * Builds the versioned state vector from a read-only {@link BotSnapshot}
 * (AC1, reusing the existing builder) plus {@link RunTelemetryExtras}.
 *
 * Pure: it never touches the scene and returns a fresh plain-JSON object, so
 * it is directly unit-testable (AC6) and shared by the game and any gym that
 * opts in (AC4).
 *
 * @param snapshot - A snapshot from `buildBotSnapshot(scene)`.
 * @param extras - The run state the snapshot does not carry.
 */
export function buildRunTelemetryState(
  snapshot: BotSnapshot,
  extras: RunTelemetryExtras,
): RunTelemetryState {
  return {
    v: RUN_TELEMETRY_STATE_VERSION,
    runSeed: snapshot.runSeed,
    player: snapshot.player
      ? {
          x: snapshot.player.x,
          y: snapshot.player.y,
          vx: snapshot.player.vx,
          vy: snapshot.player.vy,
          heading: extras.heading,
          lives: extras.lives,
          invulnerable: extras.invulnerable,
        }
      : null,
    hold: {
      minerals: extras.minerals,
      capacity: extras.mineralCapacity,
    },
    levels: {
      weapons: copyLevels(extras.weaponLevels),
      powerUps: copyLevels(extras.powerUpLevels),
    },
    enemies: snapshot.enemies.map((enemy) => ({
      x: enemy.x,
      y: enemy.y,
      alive: enemy.alive,
      archetype: enemy.archetype,
    })),
    enemyBullets: snapshot.enemyBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: snapshot.drops.map((drop) => ({
      x: drop.x,
      y: drop.y,
      type: drop.type,
    })),
    minerals: snapshot.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: mineral.type,
    })),
    boss: snapshot.boss
      ? {
          x: snapshot.boss.x,
          y: snapshot.boss.y,
          alive: snapshot.boss.alive,
          phase: snapshot.boss.phase,
        }
      : null,
    aliveCount: snapshot.aliveCount,
    wave: snapshot.wave
      ? {
          active: snapshot.wave.active,
          timeRemaining: snapshot.wave.timeRemaining,
          timeLimit: snapshot.wave.timeLimit,
        }
      : null,
  };
}

/** Copies a run-scoped level list into fresh plain-JSON entries. */
function copyLevels(levels: readonly RunTelemetryLevel[]): RunTelemetryLevel[] {
  return levels.map((entry) => ({ id: entry.id, level: entry.level }));
}

// ── Input serialisation (AC2) ────────────────────────────────────────

/**
 * Serialises the control input actually applied for the tick into plain JSON
 * (AC2). The shape is tagged with its control scheme, so a recorded run is
 * self-describing across the Asteroids and 4-directional schemes; `null`
 * (no player / no input) is recorded as JSON `null`.
 *
 * @param input - The input the ship flew with this tick.
 */
export function serialiseTelemetryInput(input: ControlInput | null): TelemetryJson {
  if (!input) return null;
  if ('forward' in input) {
    return {
      scheme: 'asteroids',
      forward: input.forward,
      turnLeft: input.turnLeft,
      turnRight: input.turnRight,
    };
  }
  return {
    scheme: 'fourDirectional',
    up: input.up,
    down: input.down,
    left: input.left,
    right: input.right,
  };
}

// ── RunTelemetry wrapper (AC2–AC6) ───────────────────────────────────

/**
 * The instrumentation wrapper over a {@link TelemetryRecorder}. It names the
 * discrete events (AC3), tags every payload with
 * {@link RUN_TELEMETRY_EVENT_VERSION} and short-circuits to a strict no-op
 * when the recorder is disabled (AC5).
 */
export class RunTelemetry {
  /**
   * @param recorder - The framework recorder. Pass a disabled recorder
   *   (e.g. `NoopTelemetryRecorder`) to make every method a no-op.
   */
  constructor(private readonly recorder: TelemetryRecorder) {}

  /** A run telemetry instance with recording disabled (strict no-op). */
  static noop(): RunTelemetry {
    return new RunTelemetry(new NoopTelemetryRecorder());
  }

  /** `false` when the underlying recorder is disabled (AC5). */
  get enabled(): boolean {
    return this.recorder.enabled;
  }

  /**
   * Starts the run: writes the run header (seed + build) and a `run_start`
   * event (AC3, AC6). A no-op when disabled.
   *
   * @param runSeed - The run's RNG seed.
   * @param build - Optional build metadata override.
   */
  startRun(runSeed: number, build?: Partial<TelemetryBuildInfo>): void {
    if (!this.enabled) return;
    this.recorder.startRun({ runSeed, build });
    this.recordEvent('run_start', { seed: runSeed });
  }

  /** Records the per-tick state + applied input (AC1/AC2). No-op if disabled. */
  recordTick(state: RunTelemetryState, input: TelemetryJson): void {
    if (!this.enabled) return;
    this.recorder.recordTick(state, input);
  }

  /** Records a hit that cost a life. */
  playerHit(lives: number): void {
    this.recordEvent('player_hit', { lives });
  }

  /** Records a hit fully absorbed by a shield (no life lost). */
  playerHitAbsorbed(): void {
    this.recordEvent('player_hit_absorbed', {});
  }

  /** Records the ship running out of lives. */
  playerDeath(): void {
    this.recordEvent('player_death', {});
  }

  /** Records a destroyed enemy/asteroid. */
  enemyKilled(archetype: string, x: number, y: number): void {
    this.recordEvent('enemy_killed', { archetype, x, y });
  }

  /** Records a power-up/weapon pickup (AC3: pickups). */
  pickup(kind: 'powerUp' | 'weapon', id: string): void {
    this.recordEvent('pickup', { kind, id });
  }

  /** Records a mineral added to the hold. */
  mineralCollected(total: number): void {
    this.recordEvent('mineral_collected', { total });
  }

  /** Records the hold filling and the choice opening (AC3). */
  holdFull(options: readonly string[]): void {
    this.recordEvent('hold_full', { options: [...options] });
  }

  /** Records the hold-full choice resolution (AC3). */
  choiceSelected(index: number, id: string): void {
    this.recordEvent('choice_selected', { index, id });
  }

  /** Records a wave starting. */
  waveStart(level: number, waveNumber: number, waveCount: number): void {
    this.recordEvent('wave_start', { level, waveNumber, waveCount });
  }

  /**
   * Records a wave being cleared. `level`/`waveNumber` are read after the
   * WaveManager has advanced, i.e. they identify the now-current (next) wave.
   */
  waveCleared(level: number, waveNumber: number): void {
    this.recordEvent('wave_cleared', { level, waveNumber });
  }

  /**
   * Records a level being cleared. `level` is read after the WaveManager has
   * advanced, i.e. it identifies the now-current (next) level.
   */
  levelCleared(level: number): void {
    this.recordEvent('level_cleared', { level });
  }

  /** Records the campaign triggering the boss encounter. */
  bossTriggered(): void {
    this.recordEvent('boss_triggered', {});
  }

  /** Records the boss spawning. */
  bossSpawn(): void {
    this.recordEvent('boss_spawn', {});
  }

  /** Records a boss phase advance. */
  bossPhase(phase: number): void {
    this.recordEvent('boss_phase', { phase });
  }

  /** Records the boss being destroyed (victory). */
  bossDefeated(): void {
    this.recordEvent('boss_defeated', {});
  }

  /** Records the run ending (AC3: win/lose). */
  runEnd(won: boolean, score: number): void {
    this.recordEvent('run_end', { won, score });
  }

  /** Drains the recorder's buffer and awaits its sink. No-op if disabled. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    await this.recorder.flush();
  }

  /**
   * Records one discrete event with the concrete event version prepended. A
   * no-op when disabled, so event call sites need no guard.
   */
  private recordEvent(
    event: RunTelemetryEvent,
    payload: Record<string, TelemetryJson>,
  ): void {
    if (!this.enabled) return;
    this.recorder.recordEvent(event, {
      v: RUN_TELEMETRY_EVENT_VERSION,
      ...payload,
    });
  }
}
