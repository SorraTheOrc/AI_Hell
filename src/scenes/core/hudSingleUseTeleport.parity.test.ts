/**
 * Gym↔game parity for the **single-use HUD rows** — Teleport and Phase Shift
 * (AH-0MW231O8Q0095LQM, parent AH-0MVY096RT006QMF4 AC7/AC8; Phase Shift
 * AH-0MW6QY70A00171QB, parent AH-0MW6O1690007P2SL AC4).
 *
 * ## Why this file exists
 *
 * Both single-use kinds hold exactly one activation whose whole state is a
 * readiness timer. Their HUD rows must read `ready` while that timer is 0,
 * the shared `next in Ns` countdown while it recharges, never a `×N` stack
 * suffix, and must grey out while recharging — **identically in `PlayScene`
 * and in every gym that shows the shared HUD** (the parent's gym↔game parity
 * rule, AH-0MUGZDTFX004RBD1).
 *
 * ## Shared-code, not duplicated, assertions
 *
 * Both scenes are booted through the shared `bootScene` harness
 * (`src/test/gameHarness.ts`) and wired through the one
 * `combatHudOptions(...)` seam (`src/scenes/core/hudWiring.ts`), so the rows
 * come from the same `HUD` model in both. Every expectation reads the shared
 * registry/store (`EffectsRegistry.applyCollect` / `consumePhaseShift` /
 * `consumeTeleport` / `levelStore().tickRecharge`) — no per-scene counter or
 * timer is read or written. The final assertion compares the two scenes' row
 * projections directly, so a scene-local divergence fails here, and both
 * kinds are exercised through the same helper so neither can drift.
 *
 * @module scenes/core/hudSingleUseTeleport.parity (AH-0MW231O8Q0095LQM)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import type { EffectsRegistry } from '../../powerups/effects';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';

// Two real Phaser scenes are booted per case; under host load the default 5 s
// per-test timeout is not enough (same headroom as the sibling parity suites).
vi.setConfig({ testTimeout: 30000 });

/** Any scene that shows the shared HUD and exposes its effects registry. */
type HudParityScene = PlayScene | GymPowerUpsUtility;

/** A single-use kind whose row this suite pins. */
interface SingleUseKind {
  id: 'phase_shift' | 'teleport';
  name: string;
  /** Spends the one ready activation (false when it is recharging). */
  spend: (registry: EffectsRegistry) => boolean;
  /** Seconds until the activation is ready again (0 = ready). */
  remaining: (registry: EffectsRegistry) => number;
  /** The level-derived recharge interval that starts on consumption. */
  rechargeTime: (registry: EffectsRegistry) => number;
}

/** Both single-use kinds travel through the same expectations. */
const SINGLE_USE_KINDS: SingleUseKind[] = [
  {
    id: 'phase_shift',
    name: 'Phase Shift',
    spend: (registry) => registry.consumePhaseShift(),
    remaining: (registry) => registry.phaseShiftRechargeRemaining(),
    rechargeTime: (registry) => registry.levelStore().phaseRechargeTime(),
  },
  {
    id: 'teleport',
    name: 'Teleport',
    spend: (registry) => registry.consumeTeleport(),
    remaining: (registry) => registry.teleportRechargeRemaining(),
    rechargeTime: (registry) => registry.levelStore().teleportRechargeTime(),
  },
];

/** One scene's single-use row projection (`undefined` when no row renders). */
interface SingleUseRowModel {
  label: string;
  value: string;
  stacks: number | undefined;
  recharge: number | undefined;
  greyed: boolean;
}

let boots: BootedGame[] = [];

afterEach(() => {
  for (const booted of boots) booted.game.destroy(true);
  boots = [];
  document.body.innerHTML = '';
  window.localStorage.clear();
});

/** Boots the shipped game scene. */
async function bootPlay(): Promise<PlayScene> {
  const booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
  boots.push(booted);
  const scene = booted.scene as PlayScene;
  // A stopped loop keeps the shared recharge clocks from advancing between a
  // test's assertions; every tick below is explicit.
  scene.game.loop.stop();
  return scene;
}

/** Boots the utility power-up gym — a shipped gym that shows the shared HUD. */
async function bootUtilityGym(): Promise<GymPowerUpsUtility> {
  const booted = await bootScene([GymPowerUpsUtility]);
  boots.push(booted);
  const scene = booted.scene as GymPowerUpsUtility;
  scene.game.loop.stop();
  return scene;
}

/** The scene's shared HUD (the game and the gym expose it by name). */
function hudOf(scene: HudParityScene): HUD {
  const hud = scene instanceof PlayScene ? scene.getHUD() : scene.getHud();
  expect(hud).toBeInstanceOf(HUD);
  return hud!;
}

/** The rendered row projection for `kind`. */
function rowOf(scene: HudParityScene, kind: SingleUseKind): SingleUseRowModel {
  const hud = hudOf(scene);
  hud.refresh();
  const row = hud.getRows().find((entry) => entry.id === kind.id);
  expect(row).toBeDefined();
  return {
    label: row!.label,
    value: row!.value,
    stacks: row!.stacks,
    recharge: row!.recharge,
    greyed: row!.greyed,
  };
}

describe('single-use HUD parity — PlayScene and GymPowerUpsUtility', () => {
  it('renders the same ready → recharging → ready row model for Phase Shift and Teleport in the game and the gym', async () => {
    const cases: Array<[string, HudParityScene]> = [
      ['PlayScene', await bootPlay()],
      ['GymPowerUpsUtility', await bootUtilityGym()],
    ];

    for (const kind of SINGLE_USE_KINDS) {
      const models: SingleUseRowModel[][] = [];

      for (const [label, scene] of cases) {
        const registry = scene.getEffectsRegistry();
        // Hold-full grant: permanently owned, ready, level 1 (a reward adds a
        // slot, never a level).
        registry.applyCollect(kind.id, true);

        const ready = rowOf(scene, kind);
        expect(ready.label, `${label} ${kind.name}`).toBe(
          `${kind.name} Lvl 1 (ready)`,
        );
        expect(ready.label, `${label} ${kind.name}`).not.toContain('×');
        expect(ready.stacks, `${label} ${kind.name}`).toBeUndefined();
        expect(ready.recharge, `${label} ${kind.name}`).toBeUndefined();
        expect(ready.greyed, `${label} ${kind.name}`).toBe(false);

        // Spending the one activation starts the single level-derived timer.
        expect(kind.spend(registry), `${label} ${kind.name}`).toBe(true);
        const recharging = rowOf(scene, kind);
        const remaining = kind.remaining(registry);
        expect(remaining, `${label} ${kind.name}`).toBeGreaterThan(0);
        expect(remaining, `${label} ${kind.name}`).toBeCloseTo(
          kind.rechargeTime(registry),
          6,
        );
        expect(recharging.recharge, `${label} ${kind.name}`).toBeCloseTo(
          remaining,
          6,
        );
        expect(recharging.label, `${label} ${kind.name}`).toBe(
          `${kind.name} Lvl 1 (next in ${Math.ceil(remaining)}s)`,
        );
        expect(recharging.label, `${label} ${kind.name}`).not.toContain('×');
        expect(recharging.stacks, `${label} ${kind.name}`).toBeUndefined();
        expect(recharging.greyed, `${label} ${kind.name}`).toBe(true);

        // The shared recharge clock — the one the scene's own tick drives —
        // returns the row to `ready`, un-greyed, with no stack suffix.
        registry.levelStore().tickRecharge(remaining + 0.01);
        const settled = rowOf(scene, kind);
        expect(settled.label, `${label} ${kind.name}`).toBe(
          `${kind.name} Lvl 1 (ready)`,
        );
        expect(settled.recharge, `${label} ${kind.name}`).toBeUndefined();
        expect(settled.greyed, `${label} ${kind.name}`).toBe(false);

        models.push([ready, recharging, settled]);
      }

      // Parity: the two scenes produce the same model, state for state.
      expect(models[0], kind.name).toEqual(models[1]);
    }
  });
});
