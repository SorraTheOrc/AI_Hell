import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_SCHEMES,
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  ACTION_NAMES,
  findConflict,
  isControlScheme,
  keyFor,
  loadSettings,
  resolveBindings,
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
        shareTelemetryDev: false,
        controlScheme: 'fourDirectional',
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

    it('never throws when storage is full, and warns exactly once (AC6)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLocalStorage({});
      // Reproduce the reported failure: a full origin quota makes every
      // write throw QuotaExceededError out of the settings row's handler.
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Setting the value exceeded the quota.', 'QuotaExceededError');
      });

      expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('Could not persist settings');
      warn.mockRestore();
      vi.restoreAllMocks();
    });

    it('never throws when storage access is denied (SecurityError) (AC6)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLocalStorage({});
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Storage access denied.', 'SecurityError');
      });

      expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      vi.restoreAllMocks();
    });

    it('round-trips a custom settings record', () => {
      const custom: SettingsRecord = {
        sfxVolume: 0.3,
        sfxMuted: true,
        bindings: { ...DEFAULT_BINDINGS, moveUp: 'I', moveDown: 'K' },
        shareTelemetryDev: false,
        controlScheme: 'asteroids',
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
        pauseToggle: 'Enter',
      };
      const custom: SettingsRecord = {
        sfxVolume: 0.5,
        sfxMuted: false,
        bindings: rebinding,
        shareTelemetryDev: true,
        controlScheme: 'fourDirectional',
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
        shareTelemetryDev: false,
        controlScheme: 'fourDirectional',
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
        pauseToggle: 'Escape',
      };
      // Rebinding moveUp onto 's' (moveDown) is a real conflict.
      expect(findConflict(bindings, 'moveUp', 's')).toBe('moveDown');
    });

    it('treats the shipped defaults as conflict-free', () => {
      const bindings: Record<ActionName, string> = { ...DEFAULT_BINDINGS };
      for (const action of ACTION_NAMES) {
        expect(findConflict(bindings, action, bindings[action])).toBeNull();
      }
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

  describe('resolveBindings / keyFor fallback (AC3, AH-0MUA8BK1E001UZUC)', () => {
    it('returns the defaults when nothing is stored', () => {
      expect(resolveBindings(undefined)).toEqual(DEFAULT_BINDINGS);
    });

    it('keeps valid stored values and fills the rest from defaults', () => {
      const resolved = resolveBindings({ moveUp: 'i' } as Partial<Record<ActionName, string>>);
      expect(resolved.moveUp).toBe('i');
      expect(resolved.moveDown).toBe(DEFAULT_BINDINGS.moveDown);
    });

    it('falls back for blank / non-string stored values', () => {
      const resolved = resolveBindings({
        moveUp: '',
        moveLeft: '   ',
        moveRight: undefined as unknown as string,
      } as Partial<Record<ActionName, string>>);
      expect(resolved.moveUp).toBe(DEFAULT_BINDINGS.moveUp);
      expect(resolved.moveLeft).toBe(DEFAULT_BINDINGS.moveLeft);
      expect(resolved.moveRight).toBe(DEFAULT_BINDINGS.moveRight);
    });

    it('keyFor returns the stored value when valid', () => {
      expect(keyFor({ ...DEFAULT_BINDINGS, moveUp: 'i' }, 'moveUp')).toBe('i');
    });

    it('keyFor falls back to the default for a blank/missing value', () => {
      expect(keyFor({ moveUp: '' } as Partial<Record<ActionName, string>>, 'moveUp')).toBe('w');
      expect(keyFor(undefined, 'pauseToggle')).toBe('Escape');
    });

    it('loadSettings validates stored bindings', () => {
      mockLocalStorage({
        ai_hell_settings: JSON.stringify({ bindings: { moveUp: 'i', moveDown: '' } }),
      });
      const loaded = loadSettings();
      expect(loaded.bindings.moveUp).toBe('i');
      expect(loaded.bindings.moveDown).toBe(DEFAULT_BINDINGS.moveDown);
    });
  });

  describe('dev telemetry sharing (AH-0MVBMQZR50069QV3)', () => {
    beforeEach(() => {
      restoreLocalStorage();
    });

    it('defaults on', () => {
      expect(DEFAULT_SETTINGS.shareTelemetryDev).toBe(true);
      mockLocalStorage({});
      expect(loadSettings().shareTelemetryDev).toBe(true);
    });

    it('resolves a legacy record without the field to on', () => {
      mockLocalStorage({
        ai_hell_settings: JSON.stringify({ sfxVolume: 0.4, bindings: { moveUp: 'i' } }),
      });
      expect(loadSettings().shareTelemetryDev).toBe(true);
    });

    it('falls back to on for non-boolean stored values', () => {
      for (const bad of ['false', 0, 1, null, {}, []]) {
        mockLocalStorage({
          ai_hell_settings: JSON.stringify({ shareTelemetryDev: bad }),
        });
        expect(loadSettings().shareTelemetryDev).toBe(true);
      }
    });

    it('falls back to on when the stored JSON is corrupt', () => {
      mockLocalStorage({ ai_hell_settings: '{broken' });
      expect(loadSettings().shareTelemetryDev).toBe(true);
    });

    it('round-trips a persisted opt-out', () => {
      mockLocalStorage({});
      saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: false });
      expect(loadSettings().shareTelemetryDev).toBe(false);
    });

    it('resetSettings restores the on default', () => {
      mockLocalStorage({});
      saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: false });
      expect(loadSettings().shareTelemetryDev).toBe(false);

      resetSettings();
      expect(loadSettings().shareTelemetryDev).toBe(true);
    });
  });

  // ── Per-player control scheme (AH-0MVIA7LRCJ006Q8SA AC1/AC2) ──────
  describe('controlScheme (AH-0MVI7LRCJ006Q8SA AC1/AC2)', () => {
    beforeEach(() => {
      restoreLocalStorage();
    });

    it('exposes the ordered scheme list derived from the union', () => {
      // The list drives the Settings UI; every member must be reachable and
      // the order must be stable so Left/Right cycling is predictable.
      expect(CONTROL_SCHEMES).toEqual(['asteroids', 'fourDirectional']);
      expect(new Set(CONTROL_SCHEMES).size).toBe(CONTROL_SCHEMES.length);
    });

    it('defaults to the shipped Asteroids scheme', () => {
      expect(DEFAULT_SETTINGS.controlScheme).toBe('asteroids');
      mockLocalStorage({});
      expect(loadSettings().controlScheme).toBe('asteroids');
    });

    it('round-trips each valid scheme, leaving other settings untouched', () => {
      for (const scheme of CONTROL_SCHEMES) {
        mockLocalStorage({});
        saveSettings({ ...DEFAULT_SETTINGS, controlScheme: scheme, sfxVolume: 0.42 });
        const loaded = loadSettings();
        expect(loaded.controlScheme).toBe(scheme);
        expect(loaded.sfxVolume).toBe(0.42);
        expect(loaded.sfxMuted).toBe(DEFAULT_SETTINGS.sfxMuted);
        expect(loaded.bindings).toEqual(DEFAULT_BINDINGS);
        expect(loaded.shareTelemetryDev).toBe(DEFAULT_SETTINGS.shareTelemetryDev);
      }
    });

    it('resolves a legacy record without the field to Asteroids, preserving the rest', () => {
      mockLocalStorage({
        ai_hell_settings: JSON.stringify({
          sfxVolume: 0.25,
          sfxMuted: true,
          bindings: { moveUp: 'i' },
          shareTelemetryDev: false,
        }),
      });
      const loaded = loadSettings();
      expect(loaded.controlScheme).toBe('asteroids');
      expect(loaded.sfxVolume).toBe(0.25);
      expect(loaded.sfxMuted).toBe(true);
      expect(loaded.bindings.moveUp).toBe('i');
      expect(loaded.shareTelemetryDev).toBe(false);
    });

    it('falls back to Asteroids for non-string stored values', () => {
      for (const bad of [0, 1, true, null, {}, []]) {
        mockLocalStorage({
          ai_hell_settings: JSON.stringify({ controlScheme: bad }),
        });
        expect(loadSettings().controlScheme).toBe('asteroids');
      }
    });

    it('falls back to Asteroids for blank and out-of-union strings', () => {
      for (const bad of ['', '   ', 'orbital', 'Asteroids', 'FOURDIRECTIONAL']) {
        mockLocalStorage({
          ai_hell_settings: JSON.stringify({ controlScheme: bad }),
        });
        expect(loadSettings().controlScheme).toBe('asteroids');
      }
    });

    it('falls back to Asteroids when the stored JSON is corrupt', () => {
      mockLocalStorage({ ai_hell_settings: '{broken' });
      expect(loadSettings().controlScheme).toBe('asteroids');
    });

    it('resetSettings restores the Asteroids default', () => {
      mockLocalStorage({});
      saveSettings({ ...DEFAULT_SETTINGS, controlScheme: 'fourDirectional' });
      expect(loadSettings().controlScheme).toBe('fourDirectional');

      resetSettings();
      expect(loadSettings().controlScheme).toBe('asteroids');
    });

    it('isControlScheme accepts only union members', () => {
      for (const scheme of CONTROL_SCHEMES) {
        expect(isControlScheme(scheme)).toBe(true);
      }
      for (const bad of ['', 'orbital', 'Asteroids', 0, null, undefined, {}]) {
        expect(isControlScheme(bad)).toBe(false);
      }
    });
  });
});
