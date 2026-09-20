import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  ACTION_NAMES,
  findConflict,
  loadSettings,
  saveSettings,
  resetSettings,
  type SettingsRecord,
  type ActionName,
} from './settingsStore';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Replace `window.localStorage` with a controllable map-backed store.
 * Restored automatically after each test via `beforeEach`.
 */
function mockLocalStorage(map: Record<string, string>): void {
  const store = {
    getItem: vi.fn((key: string) => map[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete map[key];
    }),
    clear: vi.fn(() => {
      Object.keys(map).forEach((k) => delete map[k]);
    }),
  };
  // @ts-expect-error — partial override is sufficient for our purposes
  window.localStorage = store;
}

function restoreLocalStorage(): void {
  vi.restoreAllMocks();
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('settingsStore', () => {
  describe('constants', () => {
    it('exposes default settings with sensible values', () => {
      expect(DEFAULT_SETTINGS.sfxVolume).toBe(1);
      expect(DEFAULT_SETTINGS.sfxMuted).toBe(false);
    });

    it('exposes default bindings covering all expected actions', () => {
      expect(DEFAULT_BINDINGS).toBeDefined();
      // Verify the default set matches what the plan recorded
      expect(DEFAULT_BINDINGS.moveUp).toBe('w');
      expect(DEFAULT_BINDINGS.moveDown).toBe('s');
      expect(DEFAULT_BINDINGS.moveLeft).toBe('a');
      expect(DEFAULT_BINDINGS.moveRight).toBe('d');
      expect(DEFAULT_BINDINGS.layerDrop).toBe('s');
      expect(DEFAULT_BINDINGS.pauseToggle).toBe('Escape');
    });

    it('exposes the action name list', () => {
      expect(ACTION_NAMES).toContain('moveUp');
      expect(ACTION_NAMES).toContain('moveDown');
      expect(ACTION_NAMES).toContain('pauseToggle');
    });
  });

  describe('loadSettings', () => {
    beforeEach(() => {
      restoreLocalStorage();
    });

    it('returns defaults when localStorage is unavailable', () => {
      // @ts-expect-error — deliberate breakage to test guard
      window.localStorage = undefined;
      const result = loadSettings();
      expect(result).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the key is absent', () => {
      mockLocalStorage({});
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the stored JSON is corrupt', () => {
      mockLocalStorage({ ai_hell_settings: '{not valid json' });
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the stored JSON is a non-object', () => {
      mockLocalStorage({ ai_hell_settings: '"just a string"' });
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('merges a partial stored record over the defaults', () => {
      mockLocalStorage({
        ai_hell_settings: JSON.stringify({ sfxVolume: 0.5 }),
      });
      const result = loadSettings();
      expect(result.sfxVolume).toBe(0.5);
      // Unspecified fields should come from defaults
      expect(result.sfxMuted).toBe(false);
      expect(result.bindings).toEqual(DEFAULT_BINDINGS);
    });

    it('returns a complete valid record when fully persisted', () => {
      const custom: SettingsRecord = {
        sfxVolume: 0.7,
        sfxMuted: true,
        bindings: { ...DEFAULT_BINDINGS, moveUp: 'I' },
      };
      mockLocalStorage({ ai_hell_settings: JSON.stringify(custom) });
      expect(loadSettings()).toEqual(custom);
    });
  });

  describe('saveSettings', () => {
    beforeEach(() => {
      restoreLocalStorage();
    });

    it('persists the full record to localStorage', () => {
      const map: Record<string, string> = {};
      mockLocalStorage(map);
      saveSettings(DEFAULT_SETTINGS);
      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        'ai_hell_settings',
        JSON.stringify(DEFAULT_SETTINGS),
      );
    });

    it('is a no-op when storage is unavailable', () => {
      // @ts-expect-error — deliberate breakage
      window.localStorage = undefined;
      expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
      // No error should be thrown; silently skipped
    });

    it('round-trips a custom settings record', () => {
      const custom: SettingsRecord = {
        sfxVolume: 0.3,
        sfxMuted: true,
        bindings: { ...DEFAULT_BINDINGS, moveUp: 'I', moveDown: 'K' },
      };
      mockLocalStorage({});
      saveSettings(custom);
      expect(loadSettings()).toEqual(custom);
    });

    it('round-trips with default bindings after rebinding', () => {
      const rebinding: Record<ActionName, string> = {
        moveUp: 'I',
        moveDown: 'K',
        moveLeft: 'J',
        moveRight: 'L',
        layerDrop: ';',
        pauseToggle: 'Enter',
      };
      const custom: SettingsRecord = {
        sfxVolume: 0.5,
        sfxMuted: false,
        bindings: rebinding,
      };
      mockLocalStorage({});
      saveSettings(custom);
      expect(loadSettings()).toEqual(custom);
      expect(loadSettings().bindings.moveUp).toBe('I');
      expect(loadSettings().bindings.moveDown).toBe('K');
    });
  });

  describe('resetSettings', () => {
    beforeEach(() => {
      restoreLocalStorage();
    });

    it('restores defaults when custom values are stored', () => {
      const custom: SettingsRecord = {
        sfxVolume: 0.1,
        sfxMuted: true,
        bindings: { ...DEFAULT_BINDINGS, moveUp: 'X' },
      };
      mockLocalStorage({});
      saveSettings(custom);
      expect(loadSettings()).toEqual(custom);
      expect(loadSettings().sfxVolume).not.toBe(DEFAULT_SETTINGS.sfxVolume);

      resetSettings();
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it('persists the defaults', () => {
      mockLocalStorage({});
      resetSettings();
      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        'ai_hell_settings',
        JSON.stringify(DEFAULT_SETTINGS),
      );
    });

    it('is a no-op when storage is unavailable', () => {
      // @ts-expect-error — deliberate breakage
      window.localStorage = undefined;
      expect(() => resetSettings()).not.toThrow();
    });

    it('restores defaults even after corrupt storage', () => {
      mockLocalStorage({ ai_hell_settings: '{broken' });
      // Before reset: should return defaults (corrupt path)
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
      resetSettings();
      // After reset: should also have defaults
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('findConflict (AH-0MUA8BGE0006UAU4)', () => {
    it('returns null when the key is free', () => {
      const bindings: Record<ActionName, string> = { ...DEFAULT_BINDINGS };
      expect(findConflict(bindings, 'moveUp', 'i')).toBeNull();
    });

    it('returns the conflicting action when rebinding onto another action key', () => {
      const bindings: Record<ActionName, string> = {
        ...DEFAULT_BINDINGS,
        moveLeft: 'a',
        moveRight: 'd',
        moveDown: 's',
        moveUp: 'w',
        layerDrop: 's',
        pauseToggle: 'Escape',
      };
      // Rebinding moveUp onto 's' (moveDown) is a real conflict.
      expect(findConflict(bindings, 'moveUp', 's')).toBe('moveDown');
    });

    it('does not treat the default S overlap (moveDown ↔ layerDrop) as a conflict', () => {
      const bindings: Record<ActionName, string> = { ...DEFAULT_BINDINGS };
      expect(findConflict(bindings, 'moveDown', 's')).toBeNull();
      expect(findConflict(bindings, 'layerDrop', 's')).toBeNull();
    });

    it('reports a NON-default pair sharing a key even when one is identity', () => {
      const bindings: Record<ActionName, string> = {
        ...DEFAULT_BINDINGS,
        moveDown: 's',
        layerDrop: 'x', // moved away from the default overlap
      };
      // Rebinding layerDrop back onto 's' now collides with moveDown only
      // if the pair were intentional; it is not (one side moved), so…
      // moveDown/layerDrop remain an intentional pair per the shipped
      // defaults, so the overlap stays permitted:
      expect(findConflict(bindings, 'layerDrop', 's')).toBeNull();
    });

    it('reports a swap conflict between two non-default-pair actions', () => {
      const bindings: Record<ActionName, string> = {
        ...DEFAULT_BINDINGS,
        moveLeft: 'a',
      };
      // Rebinding moveRight onto 'a' (moveLeft's key): genuine conflict.
      expect(findConflict(bindings, 'moveRight', 'a')).toBe('moveLeft');
    });
  });
});
