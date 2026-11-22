/**
 * Shared aim-hit delivery seam (AH-0MWR054VE006YSLN, Feature 5 of 8 of the
 * aim-accuracy epic AH-0MWPOET5A002IPTP).
 *
 * The adaptive aim error (AH-0MWR057Q8004PBOD) needs to know when an aimed
 * shot connected, and the bot has no such signal of its own: player-bullet
 * damage lands in the shared combat core, not in the AI layer. This module is
 * the thin bridge between the two — the scene's
 * `CombatScene.onPlayerBulletHitEnemy` hook forwards the struck enemy here,
 * and {@link notifyAimHit} resolves its bot-side identity with the **same**
 * resolver the snapshot builder uses ({@link botEntityId}) before handing the
 * id to the governor's {@link AimHitGovernor.noteAimHit} entry point.
 *
 * Keeping the id resolution here — rather than in each scene — means
 * `PlayScene` and every bot-bearing gym contain no identity logic of their
 * own: they hold one one-line hook that calls this helper, so the aim solve
 * and the hit seam can never disagree about which entity was hit.
 *
 * @module src/ai/aimHit
 */

import { botEntityId } from './botSnapshot';

/**
 * The minimal governor contract the aim-hit seam needs. `BotInputGovernor`
 * satisfies it; tests can pass a lightweight sink that records the ids.
 */
export interface AimHitGovernor {
  noteAimHit(id: number): void;
}

/**
 * Reports one confirmed player-bullet hit on `enemy` to `governor`.
 *
 * The enemy is mapped to its **bot-side identity** by {@link botEntityId},
 * the shared resolver the snapshot builder uses, so the governor compares the
 * hit against exactly the id it aimed at. An absent governor or enemy (the
 * seam runs with no bot, or the hit has no enemy) is inert — it produces no
 * signal, so the game's behaviour is unchanged when no bot is present.
 *
 * @param governor - The scene's bot governor, or `null`/`undefined` when the
 *   scene runs no bot.
 * @param enemy - The enemy the player damage landed on, or `null`/`undefined`.
 */
export function notifyAimHit(
  governor: AimHitGovernor | null | undefined,
  enemy: object | null | undefined,
): void {
  if (!governor || !enemy) return;
  governor.noteAimHit(botEntityId(enemy));
}
