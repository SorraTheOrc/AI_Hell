/**
 * Unit tests for the bot content registry (AH-0MUY08X98002TRHT, AC1/AC4/AC5).
 *
 * These exercise the public lookup seam only: registration, resolution,
 * ordering and the documented graceful default for unknown content. The
 * end-to-end synthetic-content path through the brain is covered in
 * `competent/content.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  BotContent,
  DEFAULT_DROP_PROFILE,
  DEFAULT_ENEMY_PROFILE,
  EMPTY_BOT_CONTENT,
  createBotContent,
  type DropContentProfile,
} from './content';

describe('BotContent enemy lookup (AC1)', () => {
  it('resolves a registered archetype to its profile', () => {
    const content = createBotContent({
      enemies: [
        {
          id: 'tank',
          threat: 1.4,
          engagementRange: 180,
          aim: 'direct',
          asteroidLike: false,
        },
      ],
    });

    const profile = content.resolveEnemy('tank');
    expect(profile.threat).toBe(1.4);
    expect(profile.engagementRange).toBe(180);
    expect(profile.aim).toBe('direct');
    expect(content.isAsteroidLike('tank')).toBe(false);
  });

  it('reports the asteroid-like flag for a hazard archetype', () => {
    const content = createBotContent({
      enemies: [
        { id: 'asteroid', threat: 1, aim: 'direct', asteroidLike: true },
      ],
    });
    expect(content.isAsteroidLike('asteroid')).toBe(true);
    expect(content.hasEnemy('asteroid')).toBe(true);
  });

  it('preserves registration order for deterministic iteration', () => {
    const content = createBotContent({
      enemies: [
        { id: 'scout', threat: 1, aim: 'direct', asteroidLike: false },
        { id: 'diver', threat: 1.3, aim: 'lead', asteroidLike: false },
      ],
    });
    expect(content.enemyProfiles().map((p) => p.id)).toEqual([
      'scout',
      'diver',
    ]);
  });

  it('throws on a duplicate archetype id (a content typo fails loudly)', () => {
    expect(() =>
      createBotContent({
        enemies: [
          { id: 'scout', threat: 1, aim: 'direct', asteroidLike: false },
          { id: 'scout', threat: 2, aim: 'direct', asteroidLike: false },
        ],
      }),
    ).toThrow(/scout/);
  });
});

describe('BotContent drop lookup (AC2)', () => {
  it('resolves a registered drop to its desirability value', () => {
    const content = createBotContent({
      drops: [{ id: 'extra_life', value: 1.5 }],
    });
    expect(content.resolveDrop('extra_life').value).toBe(1.5);
    expect(content.hasDrop('extra_life')).toBe(true);
    expect(content.dropProfiles().map((p) => p.id)).toEqual(['extra_life']);
  });
});

describe('unknown content degrades to the documented default (AC4)', () => {
  it('uses the neutral enemy profile for an unregistered archetype', () => {
    const content = EMPTY_BOT_CONTENT;
    expect(content.hasEnemy('mystery')).toBe(false);
    expect(content.resolveEnemy('mystery')).toEqual(DEFAULT_ENEMY_PROFILE);
    expect(content.isAsteroidLike('mystery')).toBe(false);
  });

  it('uses the neutral drop profile for an unregistered drop', () => {
    const content = EMPTY_BOT_CONTENT;
    expect(content.hasDrop('mystery')).toBe(false);
    expect(content.resolveDrop('mystery')).toEqual(DEFAULT_DROP_PROFILE);
  });

  it('allows overriding the default profile', () => {
    const customDrop: DropContentProfile = { id: 'default', value: 0.25 };
    const content = new BotContent({ defaultDrop: customDrop });
    expect(content.resolveDrop('anything')).toEqual(customDrop);
  });
});
