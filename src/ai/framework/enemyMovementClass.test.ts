/**
 * Unit tests for the bot-side archetype → movement-class map
 * (AH-0MWM0C6OW006G5SE · Feature 1 of the hazard motion-model epic).
 *
 * The map is a static literal inside the bot layer — never a config-store
 * lookup on the decision path — so the only thing that can go wrong is drift
 * from the shipped CSV. These tests therefore read
 * `src/data/enemy-configs.csv` directly and assert every archetype's
 * `movementClass` column matches the map, in both directions.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCsvRows } from '../../core/csv';
import {
  DEFAULT_BOT_ENEMY_MOVEMENT_CLASS,
  ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE,
  resolveEnemyMovementClass,
} from './enemyMovementClass';

const ENEMY_CSV = path.join(process.cwd(), 'src/data/enemy-configs.csv');

/** The committed CSV's rows, keyed by archetype. */
function csvMovementClasses(): Map<string, string> {
  const csv = fs.readFileSync(ENEMY_CSV, 'utf8');
  const rows = parseCsvRows(csv);
  expect(rows.length).toBeGreaterThan(0);
  return new Map(rows.map((row) => [row.key, row.movementClass]));
}

describe('ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE — CSV drift guard', () => {
  it('maps every CSV archetype to its committed movementClass', () => {
    for (const [archetype, movementClass] of csvMovementClasses()) {
      expect(resolveEnemyMovementClass(archetype)).toBe(movementClass);
    }
  });

  it('has no archetype the CSV does not ship (stale entries drift too)', () => {
    const csv = csvMovementClasses();
    for (const archetype of Object.keys(ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE)) {
      expect(csv.get(archetype)).toBe(
        ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE[archetype],
      );
    }
  });

  it('is frozen so no runtime path can mutate it', () => {
    expect(Object.isFrozen(ENEMY_MOVEMENT_CLASS_BY_ARCHETYPE)).toBe(true);
  });
});

describe('resolveEnemyMovementClass', () => {
  it('resolves the five movement classes from their archetypes', () => {
    expect(resolveEnemyMovementClass('scout')).toBe('formation');
    expect(resolveEnemyMovementClass('diver')).toBe('diver');
    expect(resolveEnemyMovementClass('ghost-chase')).toBe('chaser');
    expect(resolveEnemyMovementClass('raider')).toBe('patroller');
    expect(resolveEnemyMovementClass('asteroid')).toBe('roamer');
  });

  it('falls back to roamer for an unknown archetype', () => {
    expect(resolveEnemyMovementClass('no-such-archetype')).toBe('roamer');
  });

  it('falls back to roamer for an absent archetype', () => {
    expect(resolveEnemyMovementClass(undefined)).toBe('roamer');
    expect(resolveEnemyMovementClass('')).toBe('roamer');
    expect(DEFAULT_BOT_ENEMY_MOVEMENT_CLASS).toBe('roamer');
  });

  it('does not resolve inherited object properties as archetypes', () => {
    expect(resolveEnemyMovementClass('constructor')).toBe('roamer');
    expect(resolveEnemyMovementClass('__proto__')).toBe('roamer');
  });
});
