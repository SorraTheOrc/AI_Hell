/**
 * Shipped content profiles for the structured competent bot
 * (AH-0MUY08X98002TRHT).
 *
 * This is the single place the bot learns about the game's enemies,
 * power-ups and weapons. Every archetype the enemy factory can spawn and every
 * drop id the game can spawn has a profile here, so adding new content is a
 * config entry plus its game data — the framework core and the competent
 * goals/behaviours never change (AC1–AC3).
 *
 * Values are **relative** to the neutral default of `1`:
 *
 * - a `threat` above `1` makes an archetype more attractive to engage within
 *   the enemy band; below `1` makes it less so;
 * - a drop `value` above `1` makes it more attractive to collect within the
 *   power-up band;
 * - `engagementRange` is optional: omit it to use the behaviour's tunable
 *   standoff (keeping ranges single-sourced in `./tunables`).
 *
 * An archetype/drop that is not listed falls back to the documented default
 * in `../content` (AC4).
 *
 * @module src/ai/framework/competent/content
 */

import { createBotContent, type BotContent } from '../content';
import { EXTRA_LIFE_DROP_ID } from '../../../powerups/types';

/**
 * The drop id the competent bot's `secure-life` goal targets. Single-sourced
 * from the Extra Life catalogue entry so the bot never hard-codes the id
 * (AH-0MV03GXZQ00801T4 · AC2/AC3).
 */
export const SECURE_LIFE_DROP_ID = EXTRA_LIFE_DROP_ID;

/**
 * The shipped content registry consumed by `createCompetentBotBrain()`.
 *
 * Enemy archetypes mirror `createEnemyFromConfig` in `src/entities/`;
 * drop ids mirror `POWER_UP_CATALOGUE` and the weapon-drop ids in
 * `src/powerups/types.ts`. A guard test (`content.test.ts`) fails if a new
 * game id is added without a profile here.
 */
export const COMPETENT_BOT_CONTENT: BotContent = createBotContent({
  enemies: [
    // Scout fires aimed shots with a tell — track it directly and hold the
    // standoff the engine currently uses.
    { id: 'scout', threat: 1, engagementRange: 140, aim: 'direct', asteroidLike: false },
    // Divers dive at the ship and fire without a tell: a higher priority.
    { id: 'diver', threat: 1.3, engagementRange: 160, aim: 'lead', asteroidLike: false },
    // Tanks soak damage and anchor a formation: the top combat priority
    // (still inside the enemy band).
    { id: 'tank', threat: 1.4, engagementRange: 180, aim: 'direct', asteroidLike: false },
    // Phasers charge a beam from range: engage a little further out.
    { id: 'phaser', threat: 1.2, engagementRange: 200, aim: 'direct', asteroidLike: false },
    // Swarm clusters are numerous but individually weak.
    { id: 'swarm', threat: 0.9, engagementRange: 120, aim: 'direct', asteroidLike: false },
    // Harvesters roam for minerals rather than hunting the ship: do not spend
    // aim reasoning on them.
    { id: 'harvester', threat: 1, engagementRange: 140, aim: 'none', asteroidLike: false },
    // Asteroids are obstacles, not combat targets: the world model partitions
    // them into the asteroid band (AC1).
    { id: 'asteroid', threat: 1, engagementRange: 140, aim: 'direct', asteroidLike: true },
  ],
  drops: [
    // Power-ups, most desirable first (Order of the GDD's utility).
    { id: 'extra_life', value: 1.5 },
    { id: 'shield', value: 1.2 },
    { id: 'bomb', value: 1.1 },
    { id: 'speed_boost', value: 1 },
    { id: 'phase_shift', value: 1 },
    { id: 'magnet', value: 1 },
    { id: 'mineral_scoop', value: 1 },
    { id: 'teleport', value: 0.9 },
    // Weapon drops (P1/P2) are all similarly useful; `reset` merely removes a
    // weapon, so it is the least desirable.
    { id: 'spread', value: 1 },
    { id: 'dual', value: 1 },
    { id: 'rapid', value: 1 },
    { id: 'wave_laser', value: 1 },
    { id: 'ricochet', value: 1 },
    { id: 'cluster', value: 1 },
    { id: 'options', value: 1 },
    { id: 'nova', value: 1 },
    { id: 'mortar', value: 1 },
    { id: 'arc', value: 1 },
    { id: 'reset', value: 0.5 },
  ],
});
