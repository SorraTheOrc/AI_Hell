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

import { DEFAULT_CONFIG } from './configDefaults';
import type { ShipConfig } from './configTypes';
import { resolvePlayerControlScheme } from './playerScheme';

describe('resolvePlayerControlScheme (AH-0MVI7LRCJ006Q8SA AC3)', () => {
  it('returns the stored setting when present and valid, over the ship config', () => {
    expect(
      resolvePlayerControlScheme('fourDirectional', {
        ...DEFAULT_CONFIG,
        controlScheme: 'asteroids',
      }),
    ).toBe('fourDirectional');
  });

  it('an explicitly stored Asteroids choice beats a four-directional config', () => {
    expect(
      resolvePlayerControlScheme('asteroids', {
        ...DEFAULT_CONFIG,
        controlScheme: 'fourDirectional',
      }),
    ).toBe('asteroids');
  });

  it('falls back to the ship-config controlScheme when the stored setting is invalid/absent', () => {
    for (const bad of ['orbital', '', 0, null, undefined] as const) {
      expect(
        resolvePlayerControlScheme(bad, {
          ...DEFAULT_CONFIG,
          controlScheme: 'fourDirectional',
        }),
      ).toBe('fourDirectional');
    }
  });

  it('falls back to the built-in default when no level is valid', () => {
    expect(
      resolvePlayerControlScheme(
        'orbital',
        { ...DEFAULT_CONFIG, controlScheme: 'orbital' as never },
      ),
    ).toBe('asteroids');
    expect(resolvePlayerControlScheme(undefined, undefined)).toBe('asteroids');
  });

  it('handles a ship config with a missing/unrecognised controlScheme', () => {
    const missing = { ...DEFAULT_CONFIG };
    delete (missing as Partial<ShipConfig>).controlScheme;
    expect(resolvePlayerControlScheme('orbital', missing)).toBe('asteroids');
    expect(resolvePlayerControlScheme(undefined, { ...DEFAULT_CONFIG, controlScheme: 'orbital' as never })).toBe('asteroids');
  });

  it('never mutates the supplied ship-config object (deep-equal before/after)', () => {
    const shipConfig: ShipConfig = {
      ...DEFAULT_CONFIG,
      controlScheme: 'fourDirectional',
    };
    const snapshot = { ...shipConfig, controlScheme: shipConfig.controlScheme };
    resolvePlayerControlScheme('asteroids', shipConfig);
    expect(shipConfig).toEqual(snapshot);
    // The helper must not carry the stored value onto the config either.
    expect(shipConfig.controlScheme).toBe('fourDirectional');
  });

  // The stored setting is passed by value, so there is no settings object to
  // mutate; the ship-config snapshot test above covers the purity guarantee.
});
