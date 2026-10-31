/**
 * The gym family's single background decision
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEC0J0004YNJC).
 *
 * ## Decision: gyms render the game's backdrop, at a fixed representative level
 *
 * Every combat gym — `GymFormationScene` and its subclasses plus the direct
 * `CombatScene`/`CombatCoreScene` gyms — shows the **shipped** backdrop through
 * the same shared layer the game uses
 * (`CombatCoreScene._createBackground` → `createBackgroundLayer`), so what a
 * reviewer sees behind the enemies is literally the game's photo + dim overlay,
 * at the game's depths and with no gym-specific draw/swap code (AGENTS.md
 * gym↔game parity rule, `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §5.1).
 *
 * The alternative — rendering no backdrop in gyms — was rejected: the backdrop
 * is a shipped gameplay object, and the parity rule requires an enabled object
 * to run the same code in both places. The dim overlay keeps the neon vector
 * art legible, so a photo behind the comparison does not distract from it.
 *
 * ## The two documented divergences (both deliberate)
 *
 * 1. **Fixed level.** A gym pins {@link GYM_BACKGROUND_LEVEL} (level 1) instead
 *    of following a campaign level, so enemy silhouettes are always compared
 *    against a *constant* backdrop and a tuning screenshot is reproducible.
 *    `GymLevel` launches a level but still pins level 1: it previews that
 *    level's enemies and has no campaign progression of its own.
 * 2. **No warp.** Gyms never call `_setBackgroundLevel` after creation, so the
 *    level-change warp (`src/vfx/backgroundWarp.ts`) never runs — a gym has no
 *    level transition to announce.
 *
 * Both are recorded on AH-0MVSEC0J0004YNJC and in `docs/GYM_PARITY.md`.
 *
 * ## The switch
 *
 * {@link GYM_BACKGROUNDS_ENABLED} is the **one** opt-in/opt-out for the whole
 * gym family: every gym overrides `CombatCoreScene.backgroundLevel()` with
 * {@link gymBackgroundLevel}, so flipping this constant removes (or restores)
 * the backdrop in every gym at once — never per scene.
 *
 * @module scenes/gym/core/gymBackground
 */

/**
 * Campaign level whose backdrop every gym pins.
 *
 * Level 1 is the representative level: it is the first backdrop a player sees
 * and the one the campaign manifest always maps to a real photo.
 */
export const GYM_BACKGROUND_LEVEL = 1;

/**
 * Whether the gyms render the shared background layer at all.
 *
 * `true` (the shipped decision) shows the game's level-1 backdrop in every gym;
 * `false` would render no backdrop, leaving only the scene's configured
 * `backgroundColor`. One switch for the whole family — see the module doc.
 */
export const GYM_BACKGROUNDS_ENABLED = true;

/**
 * The campaign level a gym's `backgroundLevel()` override returns:
 * {@link GYM_BACKGROUND_LEVEL} while {@link GYM_BACKGROUNDS_ENABLED} is on,
 * `null` (render no backdrop) when the family opts out.
 */
export function gymBackgroundLevel(): number | null {
  return GYM_BACKGROUNDS_ENABLED ? GYM_BACKGROUND_LEVEL : null;
}
