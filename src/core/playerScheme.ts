/**
 * Effective player control scheme — single precedence helper
 * (`AH-0MVI7LRCJ006Q8SA` AC3).
 *
 * The player's control scheme has two sources of truth: the per-player
 * `ai_hell_settings.controlScheme` (localStorage, set in SettingsScene) and
 * the designer-owned `ship-config.csv` `controlScheme`. This module owns the
 * documented precedence so the game cannot drift from it:
 *
 *   1. the stored player setting, when present and valid;
 *   2. otherwise the ship config's `controlScheme`;
 *   3. otherwise the built-in default (`asteroids`).
 *
 * The resolver is **pure**: it never mutates the settings record or the
 * supplied ship config, and never touches the CSV store — settings never
 * write `ship-config.csv`.
 */

import type { ControlScheme, ShipConfig } from './configTypes';
import {
  DEFAULT_SETTINGS,
  isControlScheme,
  type SettingsRecord,
} from './settingsStore';

/** The scheme the game falls back to when nothing else is configured. */
export const DEFAULT_PLAYER_CONTROL_SCHEME: ControlScheme =
  DEFAULT_SETTINGS.controlScheme;

/**
 * Resolves the effective player control scheme with the documented
 * precedence: stored player setting → ship-config `controlScheme` → built-in
 * default. Invalid or absent inputs degrade to the next level rather than
 * throwing, and the helper never mutates either input object.
 */
export function resolvePlayerControlScheme(
  stored: Pick<SettingsRecord, 'controlScheme'> | undefined,
  shipConfig: ShipConfig | undefined,
): ControlScheme {
  // Level 1 — the stored player setting, when present and valid, wins over
  // the designer config outright (either union member, including the
  // Asteroids default, beats the config below).
  if (isControlScheme(stored?.controlScheme)) {
    return stored!.controlScheme;
  }
  // Level 2 — the ship config's `controlScheme`, when it carries a valid
  // value (a legacy/gym CSV may omit it, in which case coerce defaults apply).
  if (isControlScheme(shipConfig?.controlScheme)) {
    return shipConfig!.controlScheme;
  }
  // Level 3 — the built-in default.
  return DEFAULT_PLAYER_CONTROL_SCHEME;
}
