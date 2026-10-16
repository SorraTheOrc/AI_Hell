/**
 * Shared thrust-profile classification for the thruster hum
 * (AH-0MV78QUIX001EZN2).
 *
 * The hum is a single ship-level voice, so it cannot represent forward and
 * side thrust independently. This module owns the **one** classification used
 * by the game and every gym (gym↔game parity): given the firing-engine list
 * from the active movement model, decide whether the hum should use the
 * default (forward) profile or the quieter, higher-pitched **side** profile.
 *
 * Side engines are the lateral/turning ports across both control schemes:
 *
 * - Asteroids `leftSide` / `rightSide` — turn thrusters.
 * - fourDirectional `left` / `right` — lateral strafe thrusters.
 *
 * Everything else is forward/default: Asteroids `main` (forward) and `nose`
 * (retro-thrust), and fourDirectional `top` / `bottom` (vertical thrust).
 *
 * Arbitration is **side-wins**: when any side engine fires alongside a
 * forward engine, the side profile applies. All functions are pure and
 * side-effect free, so the rule is unit-testable without booting a scene.
 */

/** The two thruster-hum profiles: the default forward and the side variant. */
export type ThrusterHumProfile = 'forward' | 'side';

/**
 * Engine port names classified as **side** thrusters across both schemes.
 * Kept as one shared set so the game and every gym agree.
 */
export const THRUSTER_SIDE_ENGINES: ReadonlySet<string> = new Set([
  'leftSide',
  'rightSide',
  'left',
  'right',
]);

/** Whether an engine port is a side (lateral/turn) thruster. */
export function isSideEngine(engine: string): boolean {
  return THRUSTER_SIDE_ENGINES.has(engine);
}

/**
 * Derives the thruster-hum profile from a firing-engine list. Returns
 * `'side'` when **any** side engine is firing (side-wins over forward),
 * otherwise `'forward'`.
 *
 * `scale` is accepted (and ignored) so the two movement models' full firing
 * records can be passed directly.
 */
export function getThrusterProfile(
  engines: ReadonlyArray<{ engine: string; scale?: number }>,
): ThrusterHumProfile {
  for (const { engine } of engines) {
    if (THRUSTER_SIDE_ENGINES.has(engine)) return 'side';
  }
  return 'forward';
}
