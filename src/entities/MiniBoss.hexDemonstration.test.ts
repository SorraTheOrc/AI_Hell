/**
 * MiniBoss — the hex demonstration ("Rule 2", the boss wields it first) on the
 * encounter that ends a Hangar War deployment
 * (AH-0MWCOW50P002TWGP, parent AH-0MWBW1B1Z0059CC2; producer Q3 = a).
 *
 * The shipped `Boss` already carries an additive `demonstratedWeapon` hook
 * (`Boss.firePhase()` replaces the **opening** phase's volley with the
 * catalogue weapon's fan), but `MiniBoss` overrides `firePhase()` and never
 * forwards a demonstration, so the hook is unreachable from the encounter that
 * now wins a hex. This suite pins the intended behaviour at the entity level:
 *
 *  - the demonstration descriptor comes from the **shared** weapon catalogue
 *    (`hexBossDemonstration`, `src/utils/weapons.ts`) — no forked weapon table;
 *  - a configured demonstration is the **opening** phase's volley only
 *    (offsets, colour, shape and speed), while later phases keep the per-level
 *    `MiniBossPattern` design;
 *  - a config without a demonstration is byte-identical to today's behaviour
 *    (the shipped arcade mini-boss), so the campaign is untouched.
 *
 * **TEST-FIRST — the repo's red-before/green-after convention.** The `it.fails`
 * cases below fail on pre-change HEAD because `MiniBoss` currently ignores a
 * forwarded demonstration and always dispatches its design pattern. The
 * implementation item (AH-0MWCOW5IO001KJ8D) flips each `it.fails` back to a
 * plain `it` once the behaviour lands, so a leftover `it.fails` fails the
 * suite: this is a real target rather than a permanent exemption.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import type { BossDemonstratedWeapon } from './Boss';
import {
  MiniBoss,
  type MiniBossConfig,
  type MiniBossPattern,
} from './MiniBoss';
import { hexBossDemonstration } from '../core/hangarWar/hexBoss';
import type { HexGrant } from '../core/hangarWar/captureCycle';
import { BULLET_COLORS, getWeaponById } from '../utils/weapons';

/**
 * The intended additive hook: `MiniBossConfig` forwards the shipped
 * `BossConfig.demonstratedWeapon` through to `Boss`. Declared as an
 * intersection so this red-first suite type-checks before the field exists —
 * the implementation item folds it into `MiniBossConfig` itself.
 */
type DemoMiniBossConfig = MiniBossConfig & {
  demonstratedWeapon?: BossDemonstratedWeapon;
};

/**
 * A granted **weapon** with a real fan, resolved through the pure
 * `hexBossDemonstration` route. `spread` publishes the catalogue's
 * `[-30°, 0°, +30°]` fan, so the volley's geometry is observable (the hexes
 * currently authored grant single-shot weapons, so no authored hex exercises a
 * fan on its own).
 */
const SPREAD_GRANT: HexGrant = {
  grantId: 'spread',
  entryId: 'spread',
  kind: 'weapon',
  weaponId: 'spread',
};

/** The demonstration the shared catalogue publishes for {@link SPREAD_GRANT}. */
function spreadDemonstration(): BossDemonstratedWeapon {
  const demonstration = hexBossDemonstration(SPREAD_GRANT);
  if (demonstration === null) {
    throw new Error('fixture error: the spread grant must demonstrate a volley');
  }
  return demonstration;
}

/** Downward heading every boss volley is fanned around. */
const DOWNWARD = Math.PI / 2;

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MiniBossHexDemoHarness');
  }
}

describe('MiniBoss — demonstrated hex weapon volley (AH-0MWCOW50P002TWGP)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  function makeBoss(config: Partial<DemoMiniBossConfig> = {}): MiniBoss {
    return new MiniBoss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
      rng: () => 0.5,
      ...config,
    });
  }

  /**
   * A three-phase layout: the opening pattern plus two later patterns, so the
   * second phase is never the final one (the pattern counts differ on the
   * final phase, which would blur what the assertion is pinning).
   */
  function threePhase(first: MiniBossPattern): MiniBossPattern[] {
    return [first, 'spiral', 'pulse'];
  }

  // ── The descriptor is the shared catalogue's ────────────────────

  it('AC1 — the demonstration is resolved from the shared weapon catalogue', () => {
    const demonstration = spreadDemonstration();
    const weapon = getWeaponById('spread');

    expect(demonstration.offsets).toEqual([...weapon.offsets]);
    expect(demonstration.color).toBe(weapon.bulletColor);
    expect(demonstration.color).toBe(BULLET_COLORS.spread);
    expect(demonstration.shape).toBe(weapon.bulletShape);
  });

  // ── AC1: the opening volley is the demonstration's fan ──────────

  it.fails(
    'AC1 — the opening phase fires the demonstrated weapon’s volley',
    async () => {
      booted = await bootScene([HarnessScene]);
      const demonstration = spreadDemonstration();
      const boss = makeBoss({
        phases: threePhase('spread').map((pattern) => ({ pattern })),
        demonstratedWeapon: demonstration,
      });
      boss._simulateTelegraphElapsed();

      const bullets = boss.update(1_000_000, 0, 960, 540);

      // One bullet per catalogue offset (three), not the seven-pellet spread.
      expect(bullets).toHaveLength(demonstration.offsets.length);
      // The volley wears the demonstrated weapon's own colour.
      expect(bullets.every((bullet) => bullet.color === demonstration.color)).toBe(
        true,
      );
      // ... and travels at the demonstration's derived speed.
      for (const bullet of bullets) {
        expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
          demonstration.speed,
          6,
        );
      }
    },
  );

  it.fails(
    'AC1 — the volley fans around the boss’s downward heading using the catalogue offsets',
    async () => {
      booted = await bootScene([HarnessScene]);
      const demonstration = spreadDemonstration();
      const boss = makeBoss({
        phases: threePhase('spread').map((pattern) => ({ pattern })),
        demonstratedWeapon: demonstration,
      });
      boss._simulateTelegraphElapsed();

      const headings = boss
        .update(1_000_000, 0, 960, 540)
        .map((bullet) => Math.atan2(bullet.vy, bullet.vx))
        .sort((a, b) => a - b);
      const expected = demonstration.offsets
        .map((offset) => DOWNWARD + offset)
        .sort((a, b) => a - b);

      expect(headings).toHaveLength(expected.length);
      expected.forEach((angle, index) => {
        expect(headings[index]).toBeCloseTo(angle, 6);
      });
    },
  );

  // ── AC3: only the opening phase is the demonstration ────────────

  it.fails(
    'AC3 — the demonstration replaces only the opening phase',
    async () => {
      booted = await bootScene([HarnessScene]);
      const demonstration = spreadDemonstration();
      const boss = makeBoss({
        hpPerPhase: 1,
        phases: threePhase('spread').map((pattern) => ({ pattern })),
        demonstratedWeapon: demonstration,
      });

      boss._simulateTelegraphElapsed();
      expect(boss.update(1_000_000, 0, 960, 540)).toHaveLength(
        demonstration.offsets.length,
      );

      // Config HP is 1, so one hit advances to the design's second pattern.
      expect(boss.takeDamage().phaseAdvanced).toBe(true);
      expect(boss.getPhaseNumber()).toBe(2);

      boss._simulateTelegraphElapsed();
      // The design's own spiral pattern (twelve non-desperation pellets).
      expect(boss.update(2_000_000, 0, 960, 540)).toHaveLength(12);
    },
  );

  it('AC3 — the telegraph still gates the demonstrated volley', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      phases: threePhase('spread').map((pattern) => ({ pattern })),
      demonstratedWeapon: spreadDemonstration(),
    });

    boss.startTelegraph(1_000_000);
    expect(boss.isTelegraphing()).toBe(true);
    expect(boss.update(1_000_000, 0, 960, 540)).toEqual([]);
  });

  // ── AC3: the arcade mini-boss is unchanged ──────────────────────

  it('AC3 — a design without a demonstration keeps its configured patterns', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      hpPerPhase: 1,
      phases: threePhase('spread').map((pattern) => ({ pattern })),
    });

    boss._simulateTelegraphElapsed();
    // Seven-pellet forward spread in the opening phase.
    expect(boss.update(1_000_000, 0, 960, 540)).toHaveLength(7);

    expect(boss.takeDamage().phaseAdvanced).toBe(true);
    boss._simulateTelegraphElapsed();
    // Twelve-pellet spiral in the second phase.
    expect(boss.update(2_000_000, 0, 960, 540)).toHaveLength(12);
  });
});
