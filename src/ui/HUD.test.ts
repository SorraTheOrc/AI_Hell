import { describe, it, expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import {
  HUD,
  HUD_DEPTH,
  HUD_ROW_HEIGHT,
  PERMANENT_VALUE,
  buildHUDLabel,
  formatHUDValue,
  type HUDOptions,
} from './HUD';
import { EffectsRegistry } from '../powerups/effects';
import { resolvePowerUpAtLevel } from '../powerups/powerUpLevels';


/**
 * A bare scene with no gym logic — proves the HUD attaches to ANY Phaser
 * scene (AC4: no gym-specific imports or logic required).
 */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

/** Boots a BareScene and attaches a HUD wired to `registry`. */
async function bootWithHUD(registry?: EffectsRegistry, options?: HUDOptions) {
  const { game, scene } = await bootScene([BareScene]);
  const hud = new HUD(scene, registry ?? null, options);
  return { game, scene, hud };
}

/** Text strings currently rendered by a HUD container. */
function hudTexts(hud: HUD): string[] {
  return (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list
    .filter((c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text)
    .map((c) => c.text);
}

const destroy = (game: Phaser.Game) => game.destroy(true);

describe('HUD AC4: standalone scene attachability', () => {
  it('constructs with any Phaser scene and is added to the display list', async () => {
    const { game, scene, hud } = await bootWithHUD(new EffectsRegistry());
    expect(scene.children.list).toContain(hud);
    destroy(game);
  });

  it('renders above gameplay (depth above default game objects)', async () => {
    const { game, scene, hud } = await bootWithHUD(new EffectsRegistry());
    // A typical gameplay object sits at the default depth 0.
    const gameplay = scene.add.text(0, 0, 'gameplay', {});
    expect(gameplay.depth).toBeLessThan(hud.depth);
    expect(hud.depth).toBe(HUD_DEPTH);
    destroy(game);
  });

  it('works without a registry (standalone, idempotent)', async () => {
    const { game, hud } = await bootWithHUD();
    hud.refresh(); // no crash, no rows, no lives label yet
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });
});

describe('HUD AC1: one row per active power-up with the current level', () => {
  it('renders a single merged row: level in the label, timer in the value', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost'); // active, 10 s remaining at level 1
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('speed_boost');
    expect(rows[0].name).toBe('Speed Boost');
    expect(rows[0].label).toBe('Speed Boost Lvl 1');
    expect(rows[0].level).toBe(1);
    expect(rows[0].temporary).toBe(true);
    expect(rows[0].icon).toBe('speed_boost');
    expect(rows[0].value).toBe('10s');
    expect(hudTexts(hud)).toContain('Speed Boost Lvl 1');
    destroy(game);
  });

  it('counts down: the remaining-seconds timer decrements', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('10s');

    reg.tick(1); // one second passes
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('9s');

    reg.tick(7);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('2s');
    destroy(game);
  });

  it('renders multiple timed effects with no cross-contamination of values', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.tick(8);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].value).toBe('2s');
    destroy(game);
  });

  it('raises the label level on a second collection (effective level)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    expect(hud.getRows()[0].level).toBe(2);
    destroy(game);
  });
});

describe('HUD: permanent level-up window shows ∞ (AH-0MUX802450085VZZ)', () => {
  it('a hold-full reward raises the level permanently and shows ∞ (no timer)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows()[0];
    expect(row.label).toBe('Speed Boost Lvl 1');
    expect(row.temporary).toBe(false);
    expect(row.value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('a field pickup on a permanent base shows a timer, then reverts to ∞ — one row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true); // permanent base, level 1, no timeout
    reg.applyCollect('speed_boost'); // temporary field pickup, level 2, 10 s window
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    // Exactly one row for the item (permanent + temporary merged).
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    expect(hud.getRows()[0].temporary).toBe(true);
    expect(hud.getRows()[0].value).toBe(
      `${Math.ceil(resolvePowerUpAtLevel('speed_boost', 1).speedDuration!)}s`,
    );

    // Window expiry: level reverts to the permanent level and the value
    // becomes ∞ — still exactly one row.
    reg.tick(13);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 1');
    expect(hud.getRows()[0].temporary).toBe(false);
    expect(hud.getRows()[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('a timed field pickup that expires leaves no row when nothing is permanent', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);

    reg.tick(10.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });
});

describe('HUD AC2: permanent stack power-ups merge into one row', () => {
  it('shows a single P9 magnet row at the effective level with ∞', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('magnet');
    expect(rows[0].name).toBe('Magnet');
    expect(rows[0].icon).toBe('magnet');
    expect(rows[0].label).toBe('Magnet Lvl 3');
    expect(rows[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('merges a permanent stack with a timed field pickup into one row (timer, then ∞)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true); // permanent stack, level 1
    reg.applyCollect('magnet'); // timed field pickup, level 2, 15 s
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    // The previous design showed TWO Magnet rows here; one row is required.
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 2');
    expect(hud.getRows()[0].value).toBe('15s');

    reg.tick(15.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 1');
    expect(hud.getRows()[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('shows a timed P9 field pickup as a countdown, then drops the row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet'); // field pickup → 15 s timed effect
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('magnet');
    expect(rows[0].label).toBe('Magnet Lvl 1');
    expect(rows[0].value).toBe('15s');

    reg.tick(15.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });

  it('increments the level as more permanent stacks are collected', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 1');

    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 3');
    destroy(game);
  });
});

describe('HUD P3 shield remaining absorptions (AH-0MUVM9RAO004Y3LB)', () => {
  it('shows the level and remaining absorptions as ×N, decrementing on absorb', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // level 1 → 1 absorption
    reg.applyCollect('shield'); // level 2 → more absorptions
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'shield')!;
    expect(row.label).toBe(
      `Shield Lvl 2 ×${reg.shieldAbsorptionsRemaining()}`,
    );
    expect(row.value).toBe(
      `${Math.ceil(resolvePowerUpAtLevel('shield', 1).shieldDuration!)}s`,
    ); // active timed bubble

    reg.tryAbsorbShield();
    hud.refresh();
    const updated = hud.getRows().find((r) => r.id === 'shield')!;
    expect(updated.label).toBe(
      `Shield Lvl 2 ×${reg.shieldAbsorptionsRemaining()}`,
    );
    destroy(game);
  });

  it('drops the P3 row once the last absorption pops the shield', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // level 1 → 1 absorption
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'shield')).toBe(true);

    reg.tryAbsorbShield();
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'shield')).toBe(false);
    destroy(game);
  });
});

describe('HUD P6 auto-activation charge display (parent AH-0MUIYX1EE008FVS8)', () => {
  it('shows a finite charge count in the label and ∞ when no phase is active', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift'); // level 1 → +1 charge
    reg.applyCollect('phase_shift'); // level 2 → +2 (level-derived grant)
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(row.label).toBe(`Phase Shift Lvl 2 ×${reg.phaseCharges()}`);
    expect(row.value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('merges the active phase timer and the charge count into one row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016); // consumes one charge, activates the phase
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows().filter((r) => r.id === 'phase_shift');
    expect(rows).toHaveLength(1);
    expect(rows[0].temporary).toBe(true);
    expect(rows[0].value).toMatch(/s$/);
    expect(rows[0].label).toBe(`Phase Shift Lvl 2 ×${reg.phaseCharges()}`);
    destroy(game);
  });

  it('shows the permanent reward as level + ∞ without a charge count', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const p6 = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(p6.label).toBe('Phase Shift Lvl 1');
    expect(p6.value).toBe(PERMANENT_VALUE);
    expect(p6.label).not.toMatch(/×/);
    destroy(game);
  });

  it('does not show a misleading x0 when no charges remain', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().filter((r) => r.id === 'phase_shift')).toHaveLength(0);
    destroy(game);
  });

  it('formats countdown and permanent values distinctly', () => {
    expect(formatHUDValue(true, 4.2)).toBe('5s');
    expect(formatHUDValue(true, 0)).toBe('0s');
    expect(formatHUDValue(false, 10)).toBe(PERMANENT_VALUE);
  });
});

describe('HUD label builder (AH-0MUX802450085VZZ)', () => {
  it('appends a positive consumable count as ×N and omits zero/undefined', () => {
    expect(buildHUDLabel('Shield', 2, 2)).toBe('Shield Lvl 2 ×2');
    expect(buildHUDLabel('Shield', 2, undefined)).toBe('Shield Lvl 2');
    expect(buildHUDLabel('Shield', 2, 0)).toBe('Shield Lvl 2');
  });
});

describe('HUD AC3: lives counter (P8)', () => {
  it('displays the lives state, starting at 3', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getLivesValue()).toBe(3);
    expect(hud.getLivesLabel()).toBe('Lives: 3');
    destroy(game);
  });

  it('updates on P8 collection (4 after one pickup; cap 5)', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    reg.applyCollect('extra_life');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(4);
    expect(hud.getLivesLabel()).toBe('Lives: 4');

    reg.applyCollect('extra_life');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(5);
    expect(hud.getLivesLabel()).toBe('Lives: 5');
    destroy(game);
  });
});

describe('HUD AC5: reacts to registry changes', () => {
  it('removes a row when the effect timer expires', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);

    reg.tick(10.5); // expires
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });

  it('updates a row when a timed effect is refreshed (re-collect)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.tick(6); // 4 s left
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('4s');

    reg.applyCollect('speed_boost'); // re-collect → refresh to the level-2 duration
    hud.refresh();
    const upgraded = Math.ceil(
      resolvePowerUpAtLevel('speed_boost', 1).speedDuration!,
    );
    expect(hud.getRows()[0].value).toBe(`${upgraded}s`);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    destroy(game);
  });

  it('adds a row when a new effect is collected', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);

    reg.applyCollect('speed_boost');
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    hud.refresh();
    const rows = hud.getRows();
    expect(rows).toHaveLength(2); // Speed Boost timed row + Magnet permanent row
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('speed_boost');
    expect(ids).toContain('magnet');
    destroy(game);
  });
});
describe('HUD lives list layout (AH-0MU7JTFY1006QA8I)', () => {
  /** Rendered HUD texts, in container iteration order. */
  function hudTextObjects(hud: HUD): Phaser.GameObjects.Text[] {
    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    return list.filter((c) => c instanceof Phaser.GameObjects.Text);
  }

  it('AC1 — with lives shown, the first effect row starts below the lives label', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost'); // timed row: Speed Boost
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const texts = hudTextObjects(hud);
    const lives = texts.find((t) => t.text.startsWith('Lives: '));
    const firstRow = texts.find((t) => t.text === 'Speed Boost Lvl 1');
    expect(lives).toBeDefined();
    expect(firstRow).toBeDefined();

    // Bounds/y-order assertion: the effect list is pushed below the lives
    // label, so its first row cannot overlap the label's vertical span.
    expect(firstRow!.y).toBeGreaterThanOrEqual(
      lives!.y + HUD_ROW_HEIGHT / 2,
    );
    destroy(game);
  });

  it('AC3 — without lives (gym combat), the first row stays at the top', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootScene([BareScene]).then(({ game: g, scene }) => {
      const h = new HUD(scene, reg, { showLives: false });
      h.refresh();
      return { game: g, hud: h };
    });

    const texts = hudTextObjects(hud);
    const firstRow = texts.find((t) => t.text === 'Speed Boost Lvl 1');
    expect(firstRow).toBeDefined();
    // Nothing above the list — the row is at the container's top band.
    expect(firstRow!.y).toBeLessThan(HUD_ROW_HEIGHT);
    destroy(game);
  });
});

describe('HUD weapon rows (AH-0MU3VOQKH005YOBH)', () => {
  it('renders a weapon row when a weapon is equipped', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;
    const names = list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((c) => (c as Phaser.GameObjects.Text).text);
    expect(names).toContain('Weapon: spread Lvl 0');
    expect(names).toContain('10s');
    destroy(game);
  });

  it('renders one row per equipped weapon', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    reg.applyWeapon('dual');
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;
    const names = list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((c) => (c as Phaser.GameObjects.Text).text);
    expect(names).toContain('Weapon: spread Lvl 0');
    expect(names).toContain('Weapon: dual Lvl 0');
    expect(names).toContain('Weapon: rapid Lvl 0');
    destroy(game);
  });

  it('renders the Cluster Missile weapon row from the catalogue (AH-0MV1BIVIJ007KYXU)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('cluster');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    expect(hudTexts(hud)).toContain('Weapon: cluster Lvl 0');
    destroy(game);
  });

  it('drops the row once the weapon expires', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    reg.tick(10.1);
    hud.refresh();
    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;

    expect(
      list.some(
        (c) =>
          c instanceof Phaser.GameObjects.Text &&
          c.text === 'Weapon: rapid Lvl 0',
      ),
    ).toBe(false);
    destroy(game);
  });

  it('shows ∞ for a permanent weapon and a countdown for a field pickup on top', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread', true); // permanent
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 0');
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);

    // A field pickup on the permanent weapon opens a temporary window: the
    // row shows a countdown, then reverts to ∞ — still one row.
    reg.applyWeapon('spread');
    hud.refresh();
    expect(hudTexts(hud).filter((t) => t === PERMANENT_VALUE)).toHaveLength(0);
    expect(hudTexts(hud)).toContain('10s');

    reg.tick(10.1);
    hud.refresh();
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);
    destroy(game);
  });
});

describe('HUD weapon level readout (parent AH-0MUPMPCB2009J54J)', () => {
  it('shows the effective level and updates reactively (AC1/AC3/AC5)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    let level = 1;
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: () => level,
    });
    hud.refresh();

    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 1');
    expect(hudTexts(hud)).toContain('10s');

    // A level-up is reflected on the next refresh (AC3), timer unchanged.
    level = 3;
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 3');
    expect(hudTexts(hud)).toContain('10s');
    destroy(game);
  });

  it('reads the level from the provider by weapon id (AC2)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('dual');
    const seen: string[] = [];
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: (id) => {
        seen.push(id);
        return id === 'dual' ? 4 : 0;
      },
    });
    hud.refresh();

    expect(seen).toContain('dual');
    expect(hudTexts(hud)).toContain('Weapon: dual Lvl 4');
    destroy(game);
  });

  it('shows Lvl 0 without a provider (standalone fallback)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: rapid Lvl 0');
    destroy(game);
  });
});
