/**
 * Core game constants for the AI_Hell scaffold (GDD §6.4).
 *
 * The GDD fixes no canvas resolution; 16:9 (960x540) is the baseline the
 * boot scene and future gym scenes render at. See `gameConfig.ts` for how
 * these are wired into the Phaser game configuration.
 */
export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

/** Solid black background — matches the neon-on-black GDD art direction. */
export const GAME_BACKGROUND_COLOR = '#000000';