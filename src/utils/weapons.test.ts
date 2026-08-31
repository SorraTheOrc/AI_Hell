/**
 * Unit tests for the weapon catalogue and heading math (AC7).
 *
 * Tests cover:
 * - Pattern direction math (e.g. a backward shot at heading 90° → 270°)
 * - Heading from velocity + most-recent-heading fallback when stationary
 * - Per-weapon fire rates
 * - Round-robin drop order
 * - Bullet creation data from a heading
 */

import { describe, expect, test } from 'vitest';

import {
  WEAPON_CATALOGUE,
  getWeaponById,
  headingFromVelocity,
  absoluteAngle,
  bulletVelocity,
  bulletForShot,
  allBulletsForShot,
  computeHeading,
  weaponDropOrder,
  weaponRoundRobin,
  createBulletsFromHeading,
  angleToVelocity,
  WEAPON_CANNON_FIRE_RATE,
  WEAPON_SPREAD_FIRE_RATE,
  WEAPON_DUAL_FIRE_RATE,
  WEAPON_RAPID_FIRE_RATE,
  BULLET_SPEED,
} from './weapons';

describe('WEAPON_CATALOGUE', () => {
  test('contains exactly four weapons', () => {
    expect(Object.keys(WEAPON_CATALOGUE).length).toBe(4);
    expect(WEAPON_CATALOGUE.cannon).toBeDefined();
    expect(WEAPON_CATALOGUE.spread).toBeDefined();
    expect(WEAPON_CATALOGUE.dual).toBeDefined();
    expect(WEAPON_CATALOGUE.rapid).toBeDefined();
  });

  test('cannon fires single bullet (pattern length 1)', () => {
    expect(WEAPON_CATALOGUE.cannon.offsets.length).toBe(1);
    expect(WEAPON_CATALOGUE.cannon.offsets[0]).toBeCloseTo(0);
  });

  test('spread fires 3 bullets at ±30° and 0° relative to heading', () => {
    const offsets = WEAPON_CATALOGUE.spread.offsets;
    expect(offsets.length).toBe(3);
    const thirtyDeg = (30 * Math.PI) / 180;
    expect(offsets[0]).toBeCloseTo(-thirtyDeg);
    expect(offsets[1]).toBeCloseTo(0);
    expect(offsets[2]).toBeCloseTo(thirtyDeg);
  });

  test('dual fires 2 parallel bullets offset perpendicular to heading', () => {
    const weapon = WEAPON_CATALOGUE.dual;
    expect(weapon.offsets.length).toBe(2);
    // Both bullets fly parallel to the heading (0° offset)...
    expect(weapon.offsets[0]).toBeCloseTo(0);
    expect(weapon.offsets[1]).toBeCloseTo(0);
    // ...but are launched side-by-side: perpendicular positional offsets.
    expect(weapon.sideOffsets).toBeDefined();
    expect(weapon.sideOffsets![0]).toBeCloseTo(-8);
    expect(weapon.sideOffsets![1]).toBeCloseTo(8);
  });

  test('rapid fires single bullets at a markedly higher rate', () => {
    expect(WEAPON_CATALOGUE.rapid.offsets.length).toBe(1);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_CANNON_FIRE_RATE);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_SPREAD_FIRE_RATE);
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_DUAL_FIRE_RATE);
  });
});

describe('getWeaponById', () => {
  test('returns the correct definition for cannon', () => {
    const weapon = getWeaponById('cannon');
    expect(weapon.name).toBe('Cannon');
    expect(weapon.fireRateMs).toBe(WEAPON_CANNON_FIRE_RATE);
  });
});

describe('headingFromVelocity', () => {
  test('right (vx=1, vy=0) → 0 radians', () => {
    expect(headingFromVelocity(1, 0)).toBeCloseTo(0);
  });

  test('down (vx=0, vy=1) → π/2 radians', () => {
    expect(headingFromVelocity(0, 1)).toBeCloseTo(Math.PI / 2);
  });

  test('left (vx=-1, vy=0) → π radians', () => {
    expect(headingFromVelocity(-1, 0)).toBeCloseTo(Math.PI);
  });

  test('up (vx=0, vy=-1) → -π/2 radians', () => {
    expect(headingFromVelocity(0, -1)).toBeCloseTo(-Math.PI / 2);
  });

  test('diagonal down-right → π/4 radians', () => {
    expect(headingFromVelocity(1, 1)).toBeCloseTo(Math.PI / 4);
  });
});

describe('absoluteAngle: backward shot example from AC7', () => {
  test('heading 90° (down) + offset 180° → 270° (3π/2)', () => {
    // A 180° backward shot relative to a ship travelling right-down.
    // If the ship's heading is 90° (down), the backward shot is 270°.
    const heading = Math.PI / 2;
    const offset = Math.PI;
    const result = absoluteAngle(heading, offset);
    expect(result).toBeCloseTo((3 * Math.PI) / 2);
  });
});

describe('bulletVelocity', () => {
  test('0° → positive vx, zero vy', () => {
    const v = bulletVelocity(0, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(BULLET_SPEED);
    expect(v.vy).toBeCloseTo(0);
  });

  test('90° (down) → zero vx, positive vy', () => {
    const v = bulletVelocity(Math.PI / 2, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(BULLET_SPEED);
  });

  test('magnitude equals bullet speed for all angles', () => {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const v = bulletVelocity(angle, BULLET_SPEED);
      const magnitude = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      expect(magnitude).toBeCloseTo(BULLET_SPEED);
    }
  });
});

describe('bulletForShot / allBulletsForShot', () => {
  test('cannon fires one bullet straight ahead', () => {
    const cannon = getWeaponById('cannon');
    const bullet = bulletForShot(cannon, 0, 0);
    expect(bullet).not.toBeNull();
    expect(bullet!.vx).toBeCloseTo(BULLET_SPEED);
    expect(bullet!.vy).toBeCloseTo(0);
    expect(bullet!.color).toBe(0x00ffff);
    expect(bullet!.shape).toBe('circle');
  });

  test('spread fires three bullets at -30°/0°/+30° relative to heading', () => {
    const spread = getWeaponById('spread');
    const bullets = allBulletsForShot(spread, 0);
    expect(bullets.length).toBe(3);
    // Middle bullet straight ahead.
    expect(bullets[1].vx).toBeCloseTo(BULLET_SPEED);
    // Side bullets at ±30°.
    const thirtyDeg = (30 * Math.PI) / 180;
    expect(bullets[0].vx).toBeCloseTo(BULLET_SPEED * Math.cos(-thirtyDeg));
    expect(bullets[0].vy).toBeCloseTo(BULLET_SPEED * Math.sin(-thirtyDeg));
    expect(bullets[2].vx).toBeCloseTo(BULLET_SPEED * Math.cos(thirtyDeg));
    expect(bullets[2].vy).toBeCloseTo(BULLET_SPEED * Math.sin(thirtyDeg));
  });

  test('dual fires two parallel bullets offset perpendicular to heading (side-by-side)', () => {
    const dual = getWeaponById('dual');
    // Heading 0 (right): both bullets fly rightward (parallel).
    const bullets = allBulletsForShot(dual, 0);
    expect(bullets.length).toBe(2);
    expect(bullets[0].vx).toBeCloseTo(BULLET_SPEED);
    expect(bullets[1].vx).toBeCloseTo(BULLET_SPEED);
    expect(bullets[0].vy).toBeCloseTo(0);
    expect(bullets[1].vy).toBeCloseTo(0);
    // Positional offsets are perpendicular: travelling right → up/down.
    expect(bullets[0].offsetY).toBeCloseTo(-8);
    expect(bullets[1].offsetY).toBeCloseTo(8);
    expect(bullets[0].offsetX).toBeCloseTo(0);
    expect(bullets[1].offsetX).toBeCloseTo(0);
  });

  test('dual offset rotates with heading (travelling up → left/right)', () => {
    const dual = getWeaponById('dual');
    // Heading -90° (up): perpendicular is now the X axis.
    const bullets = allBulletsForShot(dual, -Math.PI / 2);
    expect(bullets[0].vx).toBeCloseTo(0);
    expect(bullets[0].vy).toBeCloseTo(-BULLET_SPEED);
    expect(bullets[0].offsetX).toBeCloseTo(-8);
    expect(bullets[1].offsetX).toBeCloseTo(8);
  });

  test('dual bullets are line-shaped', () => {
    const dual = getWeaponById('dual');
    const bullet = bulletForShot(dual, 0, 0);
    expect(bullet!.shape).toBe('line');
  });

  test('out-of-range bullet index returns null', () => {
    const cannon = getWeaponById('cannon');
    expect(bulletForShot(cannon, 0, -1)).toBeNull();
    expect(bulletForShot(cannon, 0, 1)).toBeNull();
  });
});

describe('createBulletsFromHeading', () => {
  test('creates one bullet descriptor for cannon at heading 0°', () => {
    const cannon = getWeaponById('cannon');
    const bullets = createBulletsFromHeading(cannon, 0, 100, 200);
    expect(bullets.length).toBe(1);
    expect(bullets[0]).toMatchObject({ x: 100, y: 200, angleDeg: 0, color: 0x00ffff });
  });

  test('spread at heading 0° produces angles -30/0/+30', () => {
    const spread = getWeaponById('spread');
    const bullets = createBulletsFromHeading(spread, 0, 0, 0);
    expect(bullets.length).toBe(3);
    expect(bullets[0].angleDeg).toBeCloseTo(-30);
    expect(bullets[1].angleDeg).toBeCloseTo(0);
    expect(bullets[2].angleDeg).toBeCloseTo(30);
  });

  test('dual at heading 0° produces two parallel bullets offset perpendicular', () => {
    const dual = getWeaponById('dual');
    const bullets = createBulletsFromHeading(dual, 0, 100, 200);
    expect(bullets.length).toBe(2);
    expect(bullets[0].angleDeg).toBeCloseTo(0);
    expect(bullets[1].angleDeg).toBeCloseTo(0);
    // Both fire from the ship position, offset perpendicular (up/down).
    expect(bullets[0].x).toBeCloseTo(100);
    expect(bullets[0].y).toBeCloseTo(200 - 8);
    expect(bullets[1].x).toBeCloseTo(100);
    expect(bullets[1].y).toBeCloseTo(200 + 8);
  });
});

describe('angleToVelocity', () => {
  test('0° → positive vx', () => {
    const v = angleToVelocity(0, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(BULLET_SPEED);
    expect(v.vy).toBeCloseTo(0);
  });

  test('90° → positive vy', () => {
    const v = angleToVelocity(90, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(BULLET_SPEED);
  });

  test('270° → negative vy', () => {
    const v = angleToVelocity(270, BULLET_SPEED);
    expect(v.vx).toBeCloseTo(0);
    expect(v.vy).toBeCloseTo(-BULLET_SPEED);
  });
});

describe('computeHeading', () => {
  test('returns heading from velocity when moving', () => {
    const heading = computeHeading(1, 0, null);
    expect(heading).toBeCloseTo(0);
  });

  test('falls back to lastHeading when stationary', () => {
    const heading = computeHeading(0, 0, Math.PI / 4);
    expect(heading).toBeCloseTo(Math.PI / 4);
  });

  test('falls back to defaultHeading when stationary and no lastHeading', () => {
    const heading = computeHeading(0, 0, null, Math.PI / 2);
    expect(heading).toBeCloseTo(Math.PI / 2);
  });

  test('uses velocity heading over fallback when moving', () => {
    const heading = computeHeading(1, 0, Math.PI);
    expect(heading).toBeCloseTo(0);
  });
});

describe('weaponDropOrder / weaponRoundRobin', () => {
  test('drop order is spread → dual → rapid', () => {
    expect(weaponDropOrder()).toEqual(['spread', 'dual', 'rapid']);
  });

  test('round-robin cycles through the order', () => {
    expect(weaponRoundRobin(5)).toEqual([
      'spread',
      'dual',
      'rapid',
      'spread',
      'dual',
    ]);
  });
});

describe('fire rate ordering', () => {
  test('rapid < cannon < dual < spread (lower ms = faster)', () => {
    expect(WEAPON_RAPID_FIRE_RATE).toBeLessThan(WEAPON_CANNON_FIRE_RATE);
    expect(WEAPON_CANNON_FIRE_RATE).toBeLessThan(WEAPON_DUAL_FIRE_RATE);
    expect(WEAPON_DUAL_FIRE_RATE).toBeLessThan(WEAPON_SPREAD_FIRE_RATE);
  });
});