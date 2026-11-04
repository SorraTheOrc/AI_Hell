/**
 * Gym↔game parity for the **single-use Teleport HUD row**
 * (AH-0MW231O8Q0095LQM, parent AH-0MVY096RT006QMF4 AC7/AC8).
 *
 * ## Why this file exists
 *
 * The Teleport HUD row must read `ready` while the single readiness timer is
 * 0, the shared `next in Ns` countdown while it recharges, never a `×N`
 * stack suffix, and must grey out while recharging — **identically in
 * `PlayScene` and in every gym that shows the shared HUD** (the parent's
 * gym↔game parity rule, AH-0MUGZDTFX004RBD1).
 *
 * ## Shared-code, not duplicated, assertions
 *
 * Both scenes are booted through the shared `bootScene` harness
 * (`src/test/gameHarness.ts`) and wired through the one
 * `combatHudOptions(...)` seam (`src/scenes/core/hudWiring.ts`), so the rows
 * come from the same `HUD` model in both. Every expectation reads the shared
 * registry/store (`EffectsRegistry.applyCollect` / `consumeTeleport` /
 * `levelStore().tickRecharge`) — no per-scene counter or timer is read or
 * written. The final assertion compares the two scenes' row projections
 * directly, so a scene-local divergence fails here.
 *
 * @module scenes/core/hudSingleUseTeleport.parity (AH-0MW231O8Q0095LQM)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';

// Two real Phaser scenes are booted per case; under host load the default 5 s
// per-test timeout is not enough (same headroom as the sibling parity suites).
vi.setConfig({ testTimeout: 30000 });

/** Any scene that shows the shared HUD and exposes its effects registry. */
type HudParityScene = PlayScene | GymPowerUpsUtility;

/** One scene's Teleport row projection (`undefined` when no row renders). */
interface TeleportRowModel {
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

/** The rendered Teleport row projection. */
function teleportRow(scene: HudParityScene): TeleportRowModel {
  const hud = hudOf(scene);
  hud.refresh();
  const row = hud.getRows().find((entry) => entry.id === 'teleport');
  expect(row).toBeDefined();
  return {
    label: row!.label,
    value: row!.value,
    stacks: row!.stacks,
    recharge: row!.recharge,
    greyed: row!.greyed,
  };
}

describe('single-use Teleport HUD parity — PlayScene and GymPowerUpsUtility (AH-0MW231O8Q0095LQM AC6)', () => {
  it('renders the same ready → recharging → ready row model from shared code in the game and the gym', async () => {
    const cases: Array<[string, HudParityScene]> = [
      ['PlayScene', await bootPlay()],
      ['GymPowerUpsUtility', await bootUtilityGym()],
    ];
    const models: TeleportRowModel[][] = [];

    for (const [label, scene] of cases) {
      const registry = scene.getEffectsRegistry();
      // Hold-full grant: permanently owned, ready, level 1 (a reward adds a
      // slot, never a level).
      registry.applyCollect('teleport', true);

      const ready = teleportRow(scene);
      expect(ready.label, label).toBe('Teleport Lvl 1 (ready)');
      expect(ready.label, label).not.toContain('×');
      expect(ready.stacks, label).toBeUndefined();
      expect(ready.recharge, label).toBeUndefined();
      expect(ready.greyed, label).toBe(false);

      // Spending the one warp starts the single level-derived recharge timer.
      expect(registry.consumeTeleport(), label).toBe(true);
      const recharging = teleportRow(scene);
      const remaining = registry.teleportRechargeRemaining();
      expect(remaining, label).toBeGreaterThan(0);
      expect(recharging.recharge, label).toBeCloseTo(remaining, 6);
      expect(recharging.label, label).toBe(
        `Teleport Lvl 1 (next in ${Math.ceil(remaining)}s)`,
      );
      expect(recharging.label, label).not.toContain('×');
      expect(recharging.stacks, label).toBeUndefined();
      expect(recharging.greyed, label).toBe(true);

      // The shared recharge clock — the one the scene's own tick drives —
      // returns the row to `ready`, un-greyed, with no stack suffix.
      registry.levelStore().tickRecharge(remaining + 0.01);
      const settled = teleportRow(scene);
      expect(settled.label, label).toBe('Teleport Lvl 1 (ready)');
      expect(settled.recharge, label).toBeUndefined();
      expect(settled.greyed, label).toBe(false);

      models.push([ready, recharging, settled]);
    }

    // Parity: the two scenes produce the same model, state for state.
    expect(models[0]).toEqual(models[1]);
  });
});
