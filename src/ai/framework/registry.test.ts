/**
 * Unit tests for the goal/behaviour registry (AC2).
 *
 * The registry is content's only coupling to the core: an id-keyed,
 * insertion-ordered map. These tests pin registration, lookup, duplicate
 * protection and order (which gives deterministic tie-breaks downstream).
 */

import { describe, expect, it } from 'vitest';

import {
  Registry,
  createBehaviourRegistry,
  createGoalRegistry,
  type BotBehaviour,
  type BotGoal,
} from './registry';

/** A minimal goal fixture. */
function goal(id: string): BotGoal {
  return { id, behaviourId: `behaviour:${id}`, utility: () => 0 };
}

/** A minimal behaviour fixture. */
function behaviour(id: string): BotBehaviour {
  return { id, run: () => null };
}

describe('Registry', () => {
  it('registers and retrieves items by id', () => {
    const registry = new Registry<BotGoal>();
    const a = goal('a');
    registry.register(a);

    expect(registry.get('a')).toBe(a);
    expect(registry.has('a')).toBe(true);
    expect(registry.has('missing')).toBe(false);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('preserves registration order for deterministic tie-breaks', () => {
    const registry = createGoalRegistry([goal('second'), goal('first')]);
    registry.register(goal('third'));

    expect(registry.ids()).toEqual(['second', 'first', 'third']);
    expect(registry.all().map((item) => item.id)).toEqual([
      'second',
      'first',
      'third',
    ]);
  });

  it('rejects a duplicate id rather than shadowing it', () => {
    const registry = createGoalRegistry([goal('a')]);
    expect(() => registry.register(goal('a'))).toThrow(/already has an item/);
    expect(registry.size).toBe(1);
  });

  it('require throws a descriptive error for a missing id', () => {
    const registry = createGoalRegistry([goal('a')]);
    expect(registry.require('a').id).toBe('a');
    expect(() => registry.require('nope')).toThrow(/no item with id "nope"/);
  });

  it('tracks size and supports registerAll', () => {
    const registry = new Registry<BotBehaviour>();
    registry.registerAll([behaviour('b1'), behaviour('b2')]);
    expect(registry.size).toBe(2);
  });
});

describe('createGoalRegistry / createBehaviourRegistry', () => {
  it('seeds both registries from a list', () => {
    const goals = createGoalRegistry([goal('collect'), goal('survive')]);
    const behaviours = createBehaviourRegistry([behaviour('collect')]);

    expect(goals.ids()).toEqual(['collect', 'survive']);
    expect(behaviours.ids()).toEqual(['collect']);
  });
});
