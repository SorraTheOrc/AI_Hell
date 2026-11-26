/**
 * Wave-announcement text for an elite (anomaly)
 * (AH-0MWU666IS008JOR3 AC6, parent AH-0MWL7P1AO003LKXT).
 *
 * The mechanic exists to create a decision ("kill the anomaly first or lose the
 * gap"), and a decision the player only discovers by dying is not a decision.
 * The wave's opening cue therefore **names the elite**: the plain progress
 * label (`Level 2: The Belt, Wave: 1 of 2`) is extended with the elevated
 * archetype and its bounded behaviour (`… — ELITE Scout (splitter)`), so the
 * player knows what is on the field and what it will do.
 *
 * Pure and Phaser-free: the game composes its banner with this module, and the
 * gyms (or a future capture overlay) can consume the same text without a scene
 * dependency. A wave with no elite returns the base label unchanged, so every
 * ordinary wave's announcement is byte-for-byte today's text.
 *
 * @module src/waves/eliteAnnounce
 */

import { loadEnemyConfig } from '../core/enemyConfig';
import type { EnemyConfig } from '../core/configTypes';
import type { EliteBehaviour } from '../core/eliteVocabulary';

/**
 * The minimum an announcement needs from a planned spawn. Structural so the
 * wave planner's `EnemySpawn` satisfies it without this module importing the
 * `WaveManager` (which would be a needless runtime dependency).
 */
export interface EliteAnnounceSpawn {
  /** Archetype key of the spawn. */
  readonly enemyKey: string;
  /** Set `true` by the shared elite plan for the wave's one elevated spawn. */
  readonly elite?: boolean;
}

/** The resolved, ready-to-render elite announcement for a wave. */
export interface EliteWaveAnnouncement {
  /** Archetype key elevated to elite. */
  readonly enemyKey: string;
  /** Human-readable archetype name (`Scout`, `Anomaly`, …). */
  readonly displayName: string;
  /** The spawn's one bounded behaviour. */
  readonly behaviour: EliteBehaviour;
  /** The self-contained phrase appended to the progress label. */
  readonly label: string;
}

/** The fixed marker that makes an elite readable without colour (AC5/AC6). */
export const ELITE_ANNOUNCEMENT_MARKER = 'ELITE';

/** Separator between the progress label and the elite phrase. */
export const ELITE_ANNOUNCEMENT_SEPARATOR = ' — ';

/** Archetype resolver; defaults to the CSV-backed config store. */
export type EliteAnnounceConfigFor = (enemyKey: string) => EnemyConfig;

/**
 * Resolves the wave's elite announcement from its planned spawns, or `null`
 * when the wave fields no elite.
 *
 * The source of truth is the **planned spawn list** (the shared elite plan's
 * `elite` flag), never a re-derived roll: the cue therefore names exactly the
 * hull that spawns. A flagged spawn whose archetype resolves to no behaviour
 * yields `null` (a bad/neutral config never produces a contradictory
 * announcement). A blank `displayName` falls back to the archetype key.
 *
 * @param spawns — the wave's planned spawns (in any order).
 * @param configFor — archetype resolver; defaults to the CSV-backed store.
 */
export function resolveEliteWaveAnnouncement(
  spawns: readonly EliteAnnounceSpawn[],
  configFor: EliteAnnounceConfigFor = loadEnemyConfig,
): EliteWaveAnnouncement | null {
  const spawn = spawns.find((candidate) => candidate.elite === true);
  if (!spawn) return null;

  const config = configFor(spawn.enemyKey);
  const behaviour = config.eliteBehaviour;
  if (!behaviour) return null;

  const displayName = config.displayName?.trim() || config.key || spawn.enemyKey;
  return {
    enemyKey: spawn.enemyKey,
    displayName,
    behaviour,
    label: `${ELITE_ANNOUNCEMENT_MARKER} ${displayName} (${behaviour})`,
  };
}

/**
 * Composes a wave banner's text.
 *
 * @param baseLabel — the ordinary progress label (`_progressLabel()`).
 * @param announcement — the wave's elite announcement, or `null`.
 * @returns `baseLabel` unchanged when the wave has no elite, otherwise the
 *   base label with the elite phrase appended.
 */
export function composeWaveAnnouncement(
  baseLabel: string,
  announcement: EliteWaveAnnouncement | null,
): string {
  if (!announcement) return baseLabel;
  return `${baseLabel}${ELITE_ANNOUNCEMENT_SEPARATOR}${announcement.label}`;
}
