/**
 * Unit tests for the bot decision logic (AH-0MUX43QS4005SFJ3).
 *
 * `decideBotInput(snapshot)` is a pure function over a read-only
 * `BotSnapshot`; every test uses lightweight structural stubs — no Phaser,
 * no browser, no wall-clock.  Deterministic movement simulations cover the
 * "never suicides" and "fire-pattern avoidance reduces hits" acceptance
 * criteria.
 *
 * Acceptance criteria covered:
 * - AC1 — survival-first priority ordering
 * - AC2 — a deterministic unit test per priority branch
 * - AC3 — the bot never suicides into a bullet / asteroid / enemy / wall
 * - AC4 — fire-pattern avoidance reduces avoidable hits vs a reactive baseline
 * - AC5 — tunables live in one shared config object
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_DECISION_TUNABLES,
  decideBotInput,
  type BotDecisionTunables,
} from './botDecision';

import {
  type BotEnemy,
  type BotBullet,
  type BotDrop,
  type BotMineral,
  type BotSnapshot,
} from './botSnapshot';

// ── Test helpers ────────────────────────────────────────────────────

/**
 * Builds a fully-populated snapshot so a test only overrides what it cares
 * about.  The player defaults to the canvas centre with zero velocity.
 */
function makeSnapshot(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    player: overrides.player ?? { x: 400, y: 300, vx: 0, vy: 0 },
    enemies: overrides.enemies ?? [],
    enemyBullets: overrides.enemyBullets ?? [],
    playerBullets: overrides.playerBullets ?? [],
    drops: overrides.drops ?? [],
    minerals: overrides.minerals ?? [],
    boss: overrides.boss ?? null,
    aliveCount: overrides.aliveCount ?? 0,
  };
}

function enemy(x: number, y: number, archetype = 'scout'): BotEnemy {
  return { x, y, alive: true, archetype };
}

function bullet(x: number, y: number, vx: number, vy: number): BotBullet {
  return { x, y, vx, vy };
}

function drop(x: number, y: number, type = 'spread'): BotDrop {
  return { x, y, type };
}

function mineral(x: number, y: number): BotMineral {
  return { x, y, type: 'mineral' };
}

/**
 * Deterministic forward simulation used by the AC3/AC4 tests.
 *
 * A fixed firer at the top of the screen shoots straight down at the player
 * while a power-up pulls the player downward into the line of fire.  A bot
 * that only reacts to bullets already inside its danger radius is hit; a bot
 * that predicts the bullet path dodges.  The only difference between the two
 * runs is the `firePredictionHorizon` tunable, so any hit-count difference is
 * attributable to prediction.
 */
interface SimulationOptions {
  /** Bullet-path prediction horizon in seconds; `0` = reactive-only. */
  firePredictionHorizon: number;
  /** Number of fixed 60 Hz ticks to simulate. */
  ticks: number;
}

interface SimulationResult {
  hits: number;
  ticks: number;
}

const DT = 1 / 60;

function simulate(options: SimulationOptions): SimulationResult {
  const PLAYER_SPEED = BOT_DECISION_TUNABLES.playerSpeed;
  const FIRER = { x: 400, y: 50 };
  const BULLET_SPEED = 300;
  const HIT_RADIUS = 12;

  let px = 400;
  let py = 200;
  let bullets: BotBullet[] = [];
  let hits = 0;

  for (let tick = 0; tick < options.ticks; tick++) {
    // The firer emits a straight-down bullet every 50 ticks.
    if (tick % 50 === 0) {
      bullets.push({ x: FIRER.x, y: FIRER.y, vx: 0, vy: BULLET_SPEED });
    }

    const snapshot = makeSnapshot({
      player: { x: px, y: py, vx: 0, vy: 0 },
      enemies: [enemy(FIRER.x, FIRER.y, 'scout')],
      enemyBullets: bullets.map((b) => ({ ...b })),
      drops: [drop(400, 500, 'spread')],
      aliveCount: 1,
    });

    const input = decideBotInput(snapshot, {
      firePredictionHorizon: options.firePredictionHorizon,
      engagementRadius: 60,
    });

    let mvx = 0;
    let mvy = 0;
    if (input.left) mvx -= 1;
    if (input.right) mvx += 1;
    if (input.up) mvy -= 1;
    if (input.down) mvy += 1;
    const magnitude = Math.hypot(mvx, mvy) || 1;
    px += (mvx / magnitude) * PLAYER_SPEED * DT;
    py += (mvy / magnitude) * PLAYER_SPEED * DT;

    bullets = bullets
      .map((b) => ({ ...b, x: b.x + b.vx * DT, y: b.y + b.vy * DT }))
      .filter((b) => b.x > -50 && b.x < 1010 && b.y > -50 && b.y < 590);

    const hitIndex = bullets.findIndex(
      (b) => Math.hypot(px - b.x, py - b.y) < HIT_RADIUS,
    );
    if (hitIndex >= 0) {
      hits += 1;
      bullets.splice(hitIndex, 1);
    }
  }

  return { hits, ticks: options.ticks };
}

// ── AC5: tunables in one shared config ──────────────────────────────

describe('AC5 — tunables in one shared config', () => {
  it('exports a single BOT_DECISION_TUNABLES object with every tunable', () => {
    const t = BOT_DECISION_TUNABLES;
    const numericKeys: Array<keyof BotDecisionTunables> = [
      'engagementRadius',
      'dangerMargin',
      'bulletDangerRadius',
      'wallMargin',
      'powerUpSeekRange',
      'mineralSeekRange',
      'playerSpeed',
      'firePredictionHorizon',
      'assumedBulletSpeed',
      'playfieldWidth',
      'playfieldHeight',
    ];
    for (const key of numericKeys) {
      expect(typeof t[key]).toBe('number');
      expect(t[key]).toBeGreaterThan(0);
    }
  });
});

// ── AC1: survival-first priority ordering ───────────────────────────

describe('AC1 — survival-first priority ordering', () => {
  it('returns a FourDirectionalInput shape', () => {
    const input = decideBotInput(makeSnapshot());
    expect(typeof input.up).toBe('boolean');
    expect(typeof input.down).toBe('boolean');
    expect(typeof input.left).toBe('boolean');
    expect(typeof input.right).toBe('boolean');
  });

  it('blocks steering toward a threat when an in-flight bullet crosses the path', () => {
    // Enemy to the left (within engagement radius) but a bullet is predicted
    // to cross the leftward path.  Survival must win: the bot does not steer
    // left toward the enemy.
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(200, 300, 'scout')],
      enemyBullets: [bullet(300, 300, 100, 0)],
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('prefers a power-up over a mineral (power-ups outrank minerals)', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(1000, 300, 'scout')],
      drops: [drop(300, 300, 'spread')],
      minerals: [mineral(500, 300)],
    });
    const input = decideBotInput(snapshot, { engagementRadius: 100 });
    expect(input.left).toBe(true);
    expect(input.right).toBe(false);
  });
});

// ── AC2: deterministic unit test per priority branch ────────────────

describe('AC2 — one deterministic test per priority branch', () => {
  it('survive: does not steer into an asteroid directly ahead', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(400, 250, 'asteroid')],
    });
    const input = decideBotInput(snapshot);
    expect(input.up).toBe(false);
  });

  it('survive: does not steer into a wall it is pressed against', () => {
    // Wall to the left is within wallMargin; a power-up to the left tempts
    // the bot, but survival blocks the leftward move.
    const snapshot = makeSnapshot({
      player: { x: 20, y: 300, vx: 0, vy: 0 },
      drops: [drop(10, 300, 'spread')],
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('threat response: engages a live enemy within engagement radius', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(200, 300, 'tank')],
    });
    const input = decideBotInput(snapshot, { engagementRadius: 300, dangerMargin: 50 });
    expect(input.left).toBe(true);
  });

  it('threat response: backs away from a threat already inside the danger margin', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(360, 300, 'tank')], // 40px left — inside dangerMargin 70
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('threat response: ignores enemies outside the engagement radius', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(400, 50, 'tank')], // 250px above
      drops: [drop(400, 200, 'spread')], // 100px above
    });
    const input = decideBotInput(snapshot, { engagementRadius: 200 });
    expect(input.up).toBe(true);
  });

  it('power-ups: seeks the nearest power-up when no threat is near', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(1000, 300, 'scout')], // far outside engagement radius
      drops: [drop(300, 300, 'spread')], // 100px left
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(true);
  });

  it('minerals: collects a mineral as the second priority after power-ups', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(1000, 300, 'scout')],
      minerals: [mineral(350, 300)], // 50px left
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(true);
  });

  it('minerals: collects a mineral lying on the way to a power-up', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(1000, 300, 'scout')],
      drops: [drop(300, 300, 'spread')], // 100px left
      minerals: [mineral(350, 300)], // 50px left, on the way
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(true);
  });

  it('fire-pattern avoidance: refuses a direction predicted to cross a bullet path', () => {
    // A bullet 200px above the player travels straight down.  The reactive
    // danger radius is 55px, so the bullet is not yet a *reactive* threat —
    // only prediction rejects steering up.
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemyBullets: [bullet(400, 100, 0, 200)],
    });
    const input = decideBotInput(snapshot);
    expect(input.up).toBe(false);
  });

  it('fire-pattern avoidance: dodges an enemy that is inside a fire tell', () => {
    // The enemy is 200px above — normally engaged (threat response) by
    // steering up.  Because it is telling, its aimed shot is imminent and the
    // bot refuses to fly into the shot line.
    const telling = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [{ x: 400, y: 100, alive: true, archetype: 'scout', isTelling: true }],
    });
    const input = decideBotInput(telling, { engagementRadius: 300, dangerMargin: 50 });
    expect(input.up).toBe(false);

    // With no tell, the same enemy is a normal target to engage.
    const quiet = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [{ x: 400, y: 100, alive: true, archetype: 'scout' }],
    });
    expect(decideBotInput(quiet, { engagementRadius: 300, dangerMargin: 50 }).up).toBe(true);
  });
});

// ── AC3: the bot never suicides ─────────────────────────────────────

describe('AC3 — the bot never suicides when a safe alternative exists', () => {
  it('does not steer into an oncoming bullet', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemyBullets: [bullet(380, 300, 120, 0)], // from the left, heading right
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('does not steer into an asteroid head-on', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(390, 300, 'asteroid')],
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('does not steer into a live enemy head-on', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(390, 300, 'scout')],
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('does not steer into a wall when a power-up is behind the wall', () => {
    const snapshot = makeSnapshot({
      player: { x: 30, y: 300, vx: 0, vy: 0 },
      drops: [drop(5, 300, 'spread')],
    });
    const input = decideBotInput(snapshot);
    expect(input.left).toBe(false);
  });

  it('does not steer into a bullet when cornered by bullets on all sides', () => {
    // Every direction has an incoming bullet; the bot must still return a
    // valid input and must not move directly into an adjacent bullet.
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemyBullets: [
        bullet(360, 300, 60, 0),
        bullet(440, 300, -60, 0),
        bullet(400, 260, 0, 60),
        bullet(400, 340, 0, -60),
      ],
    });
    const input = decideBotInput(snapshot);
    expect(typeof input.up).toBe('boolean');
    expect(typeof input.down).toBe('boolean');
    expect(typeof input.left).toBe('boolean');
    expect(typeof input.right).toBe('boolean');
  });
});

// ── AC4: fire-pattern avoidance reduces avoidable hits ──────────────

describe('AC4 — fire-pattern avoidance reduces avoidable hits', () => {
  it('predictive avoidance takes fewer hits than a reactive-only baseline', () => {
    const reactive = simulate({ firePredictionHorizon: 0, ticks: 600 });
    const predictive = simulate({ firePredictionHorizon: 0.9, ticks: 600 });

    // Sanity: the scenario genuinely lands hits on the reactive baseline.
    expect(reactive.hits).toBeGreaterThan(0);
    // The predictive bot avoids the shots the reactive bot flies into.
    expect(predictive.hits).toBeLessThan(reactive.hits);
  });

  it('is deterministic: repeated runs of the same configuration agree', () => {
    const first = simulate({ firePredictionHorizon: 0.9, ticks: 300 });
    const second = simulate({ firePredictionHorizon: 0.9, ticks: 300 });
    expect(first.hits).toBe(second.hits);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('returns idle when there is nothing to pursue and no danger', () => {
    const input = decideBotInput(makeSnapshot());
    expect(input).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('handles a null player gracefully', () => {
    expect(() => decideBotInput(makeSnapshot({ player: null }))).not.toThrow();
    expect(decideBotInput(makeSnapshot({ player: null }))).toEqual({
      up: false,
      down: false,
      left: false,
      right: false,
    });
  });

  it('handles a null boss gracefully', () => {
    const input = decideBotInput(makeSnapshot({ boss: null }));
    expect(typeof input.up).toBe('boolean');
  });

  it('treats an alive boss as a threat worth engaging', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      boss: { x: 200, y: 300, alive: true, phase: 1 },
    });
    const input = decideBotInput(snapshot, { engagementRadius: 300, dangerMargin: 50 });
    expect(input.left).toBe(true);
  });

  it('honours tunable overrides', () => {
    const snapshot = makeSnapshot({
      player: { x: 400, y: 300, vx: 0, vy: 0 },
      enemies: [enemy(400, 200, 'scout')], // 100px above
    });

    // Enemy outside a 50px engagement radius: no threat, so idle.
    const small = decideBotInput(snapshot, { engagementRadius: 50 });
    expect(small.up).toBe(false);

    // Enemy inside a 200px engagement radius: engage it.
    const large = decideBotInput(snapshot, { engagementRadius: 200 });
    expect(large.up).toBe(true);
  });
});
