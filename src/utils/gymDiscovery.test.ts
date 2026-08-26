/**
 * Unit tests for gym scene discovery (AC3/AC4/AC6):
 *  - `.test.ts` modules are excluded,
 *  - display labels strip the leading `Gym` prefix,
 *  - entries are sorted alphabetically by label,
 *  - module → entry mapping carries the scene classes through.
 *
 * The discovery functions are pure: tests feed them a hand-built
 * `path → module` map instead of the real `import.meta.glob` result.
 */
import { describe, expect, it } from 'vitest';

import {
  discoverGymScenes,
  displayLabelFromKey,
  isTestModulePath,
  sceneClassFromModule,
  sceneKeyFromPath,
} from './gymDiscovery';

describe('gymDiscovery', () => {
  describe('sceneKeyFromPath', () => {
    it('derives the scene key from the file basename without the .ts extension', () => {
      expect(sceneKeyFromPath('/src/scenes/gym/GymScout.ts')).toBe('GymScout');
      expect(sceneKeyFromPath('/src/scenes/gym/GymPlayer.ts')).toBe('GymPlayer');
      expect(sceneKeyFromPath('./gym/GymTank.ts')).toBe('GymTank');
    });

    it('keeps the test-suffix in the raw key (filtering happens separately)', () => {
      expect(sceneKeyFromPath('/src/scenes/gym/GymScout.test.ts')).toBe('GymScout.test');
    });
  });

  describe('displayLabelFromKey', () => {
    it('strips the leading Gym prefix for display', () => {
      expect(displayLabelFromKey('GymScout')).toBe('Scout');
      expect(displayLabelFromKey('GymPlayer')).toBe('Player');
      expect(displayLabelFromKey('GymTank')).toBe('Tank');
    });

    it('leaves keys without a Gym prefix untouched', () => {
      expect(displayLabelFromKey('Foo')).toBe('Foo');
      expect(displayLabelFromKey('')).toBe('');
    });
  });

  describe('isTestModulePath', () => {
    it('flags .test.ts modules', () => {
      expect(isTestModulePath('/src/scenes/gym/GymScout.test.ts')).toBe(true);
      expect(isTestModulePath('GymScout.test.ts')).toBe(true);
    });

    it('accepts production modules', () => {
      expect(isTestModulePath('/src/scenes/gym/GymScout.ts')).toBe(false);
      expect(isTestModulePath('GymScout.ts')).toBe(false);
    });
  });

  describe('sceneClassFromModule', () => {
    // Stand-ins for the scene classes.
    const ClassB = class GymScout {};
    const ClassD = class GymTank {};

    it('recovers the class exported under the scene key (class == file name convention)', () => {
      const ns = { GymScout: ClassB, SCOUT_FORMATION_COUNT: 6 };
      expect(sceneClassFromModule(ns, 'GymScout')).toBe(ClassB);
    });

    it('returns undefined when the key is missing or not a function', () => {
      expect(sceneClassFromModule({ GymScout: ClassB }, 'GymTank')).toBeUndefined();
      expect(sceneClassFromModule({ GymScout: 'not-a-class' }, 'GymScout')).toBeUndefined();
      expect(sceneClassFromModule(undefined, 'GymScout')).toBeUndefined();
      expect(sceneClassFromModule(null, 'GymScout')).toBeUndefined();
      expect(sceneClassFromModule(ClassD, 'GymTank')).toBeUndefined();
    });
  });

  describe('discoverGymScenes', () => {
    // Stand-ins for the scene classes; discovery only carries them through.
    const ClassA = class GymPlayer {};
    const ClassB = class GymScout {};
    const ClassC = class GymDiver {};
    const ClassD = class GymTank {};

    it('excludes .test.ts modules and derives key/label per module', () => {
      const modules = {
        '/src/scenes/gym/GymScout.ts': ClassB,
        '/src/scenes/gym/GymScout.test.ts': 'should be excluded',
        '/src/scenes/gym/GymTank.ts': ClassD,
      };

      const entries = discoverGymScenes(modules);

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.key)).toEqual(['GymScout', 'GymTank']);
      expect(entries.map((e) => e.label)).toEqual(['Scout', 'Tank']);
      expect(entries.map((e) => e.module)).toEqual([ClassB, ClassD]);
    });

    it('sorts entries alphabetically by label, not by object insertion order', () => {
      const modules = {
        '/src/scenes/gym/GymTank.ts': ClassD,
        '/src/scenes/gym/GymPlayer.ts': ClassA,
        '/src/scenes/gym/GymScout.ts': ClassB,
        '/src/scenes/gym/GymDiver.ts': ClassC,
      };

      const entries = discoverGymScenes(modules);

      expect(entries.map((e) => e.label)).toEqual(['Diver', 'Player', 'Scout', 'Tank']);
      expect(entries.map((e) => e.key)).toEqual([
        'GymDiver',
        'GymPlayer',
        'GymScout',
        'GymTank',
      ]);
    });

    it('carries the scene module (class) through each entry', () => {
      const entries = discoverGymScenes({
        '/src/scenes/gym/GymScout.ts': ClassB,
      });
      expect(entries[0].module).toBe(ClassB);
    });
  });
});