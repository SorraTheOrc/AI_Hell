/**
 * Legacy-policy adapter.
 *
 * The original pure decision function (`decideBotIntent`/`decideBotInput` in
 * `src/ai/botDecision.ts`) predates the framework and is still exercised by
 * the existing unit tests and the gyms. Rather than delete it, the framework
 * exposes it behind the {@link BotPolicy} interface so it can be used
 * unchanged — most importantly as the default fallback of {@link BotBrain}
 * while content goals are migrated (AC4).
 *
 * A documented parity test (`legacyPolicy.test.ts`) pins the adapter's output
 * to `decideBotIntent`, so the two can never drift.
 *
 * @module src/ai/framework/legacyPolicy
 */

import {
  decideBotIntent,
  type BotDecisionTunables,
  type BotSteeringIntent,
} from '../botDecision';
import type { BotSnapshot } from '../botSnapshot';
import type { BotPolicy } from './botBrain';

/**
 * Wraps the legacy pure decision as a {@link BotPolicy}.
 *
 * The framework's injected `dt` is ignored (the legacy decision is
 * instantaneous and stateless); commitment/hysteresis is the framework's job.
 *
 * @param tunables — optional partial override of `BOT_DECISION_TUNABLES`.
 */
export function createLegacyBotPolicy(
  tunables?: Partial<BotDecisionTunables>,
): BotPolicy {
  return {
    decide(snapshot: BotSnapshot, _dt: number): BotSteeringIntent {
      return decideBotIntent(snapshot, tunables);
    },
  };
}
