/**
 * Unit tests for the effective-player-scheme resolution helper
 * (`resolvePlayerControlScheme`, AH-0MVI7LRCJ006Q8SA AC3).
 *
 * Documents the single precedence contract: valid stored player setting →
 * ship-config `controlScheme` → built-in default (`asteroids`), and the
 * guarantee that the helper is pure — it never mutates the supplied ship
 * config and never touches the CSV store.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type SettingsRecord } from './settingsStore';
import { DEFAULT_CONFIG } from './configDefaults';
import type { ShipConfig } from './configTypes';
import { resolvePlayerControlScheme } from './playerScheme';

describe('resolvePlayerControlScheme (AH-0MVI7LRCJ006Q8SA AC3)', () => {
  it('returns the stored setting when present and valid, over the ship config', () => {
    expect(
      resolvePlayerControlScheme(
        { ...DEFAULT_SETTINGS, controlScheme: 'fourDirectional' },
        { ...DEFAULT_CONFIG, controlScheme: 'asteroids' },
      ),
    ).toBe('fourDirectional');
  });

  it('falls back to the ship-config controlScheme when the stored setting is invalid', () => {
    for (const bad of ['orbital', '', 0, null, undefined] as const) {
      expect(
        resolvePlayerControlScheme(
          // The `as never` cast forces the invalid stored value through the
          // type boundary the runtime path can hit with a legacy/corrupt
          // record; the helper must degrade rather than throw.
          { ...DEFAULT_SETTINGS, controlScheme: bad as never },
          { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' },
        ),
      ).toBe('fourDirectional');
    }
  });

  it('falls back to the built-in default when no level is valid', () => {
    expect(
      resolvePlayerControlScheme({ ...DEFAULT_SETTINGS, controlScheme: 'orbital' as never }, {
        ...DEFAULT_CONFIG,
        controlScheme: 'orbital' as never,
      }),
    ).toBe('asteroids');
    expect(resolvePlayerControlScheme(undefined, undefined)).toBe('asteroids');
  });

  it('handles a ship config with a missing/unrecognised controlScheme', () => {
    const missing = { ...DEFAULT_CONFIG };
    delete (missing as Partial<ShipConfig>).controlScheme;
    expect(
      resolvePlayerControlScheme({ ...DEFAULT_SETTINGS, controlScheme: 'orbital' as never }, missing),
    ).toBe('asteroids');
    expect(
      resolvePlayerControlScheme({ ...DEFAULT_SETTINGS, controlScheme: 'asteroids' }, missing),
    ).toBe('asteroids');
  });

  it('never mutates the supplied ship-config object (deep-equal before/after)', () => {
    const shipConfig: ShipConfig = {
      ...DEFAULT_CONFIG,
      controlScheme: 'fourDirectional',
    };
    const snapshot = { ...shipConfig, controlScheme: shipConfig.controlScheme };
    resolvePlayerControlScheme({ ...DEFAULT_SETTINGS, controlScheme: 'asteroids' }, shipConfig);
    expect(shipConfig).toEqual(snapshot);
    // The helper must not carry the stored value onto the config either.
    expect(shipConfig.controlScheme).toBe('fourDirectional');
  });

  it('never mutates the stored settings record either', () => {
    const stored: SettingsRecord = {
      ...DEFAULT_SETTINGS,
      controlScheme: 'fourDirectional',
    };
    const snapshot = { ...stored, controlScheme: stored.controlScheme };
    resolvePlayerControlScheme(stored, { ...DEFAULT_CONFIG, controlScheme: 'asteroids' });
    expect(stored).toEqual(snapshot);
  });

  it('chooses asteroids when the stored setting is asteroids even if the config differs', () => {
    expect(
      resolvePlayerControlScheme(
        { ...DEFAULT_SETTINGS, controlScheme: 'asteroids' },
        { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' },
      ),
    ).toBe('asteroids');
  });
});
