import { describe, it, expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { HUD, HUD_DEPTH, HUD_ROW_HEIGHT, PERMANENT_VALUE, formatValue, type HUDOptions } from './HUD';
import { EffectsRegistry } from '../powerups/effects';
import { resolvePowerUpAtLevel } from '../powerups/powerUpLevels';
import { PowerUpType } from '../powerups/types';

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

describe('HUD AC1: aggregated model for timed power-ups', () => {
  it('renders a row per active timed effect: icon, name, remaining seconds', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5'); // active, 10 s remaining
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('P5');
    expect(rows[0].name).toBe('Speed Boost');
    expect(rows[0].icon).toBe(PowerUpType.SPEED_BOOST);
    expect(rows[0].value).toBe('10s');
    destroy(game);
  });

  it('counts down: the remaining-seconds timer decrements', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
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
    reg.applyCollect('P5');
    reg.tick(8);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].value).toBe('2s');
    destroy(game);
  });
});

describe('HUD AC2: stack counts for stackable types', () => {
  it('shows the P9 magnet stack count as a pickup count', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('P9');
    expect(rows[0].name).toBe('Magnet');
    expect(rows[0].icon).toBe(PowerUpType.MAGNET);
    expect(rows[0].value).toBe('x3');
    destroy(game);
  });

  it('increments the count as more stacks are collected', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('x1');

    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('x3');
    destroy(game);
  });

  it('shows a timed P9 field pickup as remaining seconds, not a stack count', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9'); // field pickup → 15 s timed effect
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('P9');
    expect(rows[0].name).toBe('Magnet');
    expect(rows[0].value).toBe('15s');
    destroy(game);
  });
});

describe('HUD P3 shield remaining absorptions (AH-0MUVM9RAO004Y3LB)', () => {
  it('shows the remaining absorptions as xN and decrements as hits are absorbed', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3'); // level 0 → 1 absorption
    reg.applyCollect('P3'); // level 1 → 2 absorptions
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'P3')!;
    expect(row.name).toBe('Shield');
    expect(row.value).toBe(
      `x${resolvePowerUpAtLevel('P3', 1).shieldAbsorptions!}`,
    );

    reg.tryAbsorbShield();
    hud.refresh();
    const updated = hud.getRows().find((r) => r.id === 'P3')!;
    expect(updated.value).toBe(`x${reg.shieldAbsorptionsRemaining()}`);
    destroy(game);
  });

  it('drops the P3 row once the last absorption pops the shield', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3'); // level 0 → 1 absorption
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'P3')).toBe(true);

    reg.tryAbsorbShield();
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'P3')).toBe(false);
    destroy(game);
  });
});

describe('HUD P6 auto-activation charge display (parent AH-0MUIYX1EE008FVS8)', () => {
  it('shows a finite charge as xN and decrements live on trigger', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6'); // level 1 → +1
    reg.applyCollect('P6'); // level 2 → +2 (level-derived grant)
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().find((r) => r.id === 'P6')!.value).toBe('x3');

    // Consume one charge (the phase is now active, so a timer row also
    // appears; the charge row must read x2).
    reg.updateDanger(true, 0.016);
    hud.refresh();
    const chargeRow = hud
      .getRows()
      .find((r) => r.id === 'P6' && r.value.startsWith('x'))!;
    expect(chargeRow.value).toBe('x2');
    destroy(game);
  });

  it('shows the permanent reward as unlimited instead of a number', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const p6 = hud.getRows().find((r) => r.id === 'P6')!;
    expect(p6.value).toBe(PERMANENT_VALUE);
    expect(p6.value).not.toMatch(/^x/);
    destroy(game);
  });

  it('does not show a misleading x0 when no charges remain', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().filter((r) => r.id === 'P6')).toHaveLength(0);
    destroy(game);
  });

  it('formats charges, unlimited and timers distinctly', () => {
    expect(
      formatValue({ id: 'P6', type: PowerUpType.PHASE_SHIFT, stacks: 1 }),
    ).toBe('x1');
    expect(
      formatValue({
        id: 'P6',
        type: PowerUpType.PHASE_SHIFT,
        permanent: true,
      }),
    ).toBe(PERMANENT_VALUE);
    expect(
      formatValue({
        id: 'P5',
        type: PowerUpType.SPEED_BOOST,
        duration: 10,
        remaining: 4.2,
      }),
    ).toBe('5s');
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

    reg.applyCollect('P8');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(4);
    expect(hud.getLivesLabel()).toBe('Lives: 4');

    reg.applyCollect('P8');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(5);
    expect(hud.getLivesLabel()).toBe('Lives: 5');
    destroy(game);
  });
});

describe('HUD AC5: reacts to registry changes', () => {
  it('removes a row when the effect timer expires', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
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
    reg.applyCollect('P5');
    reg.tick(6); // 4 s left
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('4s');

    reg.applyCollect('P5'); // re-collect → refresh to the level-1 duration
    hud.refresh();
    const upgraded = Math.ceil(
      resolvePowerUpAtLevel('P5', 1).speedDuration!,
    );
    expect(hud.getRows()[0].value).toBe(`${upgraded}s`);
    destroy(game);
  });

  it('adds a row when a new effect is collected', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);

    reg.applyCollect('P5');
    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);
    hud.refresh();
    const rows = hud.getRows();
    expect(rows).toHaveLength(2); // P5 timed row + P9 stack row
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('P5');
    expect(ids).toContain('P9');
    destroy(game);
  });
});
describe('HUD lives list layout (AH-0MU7JTFY1006QA8I)', () => {
  /** Rendered HUD texts, in container iteration order. */
  function hudTexts(hud: HUD): Phaser.GameObjects.Text[] {
    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    return list.filter((c) => c instanceof Phaser.GameObjects.Text);
  }

  it('AC1 — with lives shown, the first effect row starts below the lives label', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5'); // timed row: Speed Boost
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const texts = hudTexts(hud);
    const lives = texts.find((t) => t.text.startsWith('Lives: '));
    const firstRow = texts.find((t) => t.text === 'Speed Boost');
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
    reg.applyCollect('P5');
    const { game, hud } = await bootScene([BareScene]).then(({ game: g, scene }) => {
      const h = new HUD(scene, reg, { showLives: false });
      h.refresh();
      return { game: g, hud: h };
    });

    const texts = hudTexts(hud);
    const firstRow = texts.find((t) => t.text === 'Speed Boost');
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
    expect(names).toContain('Weapon: spread');
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
    expect(names).toContain('Weapon: spread');
    expect(names).toContain('Weapon: dual');
    expect(names).toContain('Weapon: rapid');
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
          c.text === 'Weapon: rapid',
      ),
    ).toBe(false);
    destroy(game);
  });
});

describe('HUD weapon level readout (parent AH-0MUPMPCB2009J54J)', () => {
  it('shows Lv.N for an upgraded weapon and updates reactively (AC1/AC3/AC5)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    let level = 1;
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: () => level,
    });
    hud.refresh();

    // A level-1 weapon shows no suffix (AC4) alongside its timer (AC5).
    expect(hudTexts(hud)).toContain('Weapon: spread');
    expect(hudTexts(hud)).toContain('10s');
    expect(hudTexts(hud).some((t) => t.includes('Lv.'))).toBe(false);

    // A level-up is reflected on the next refresh (AC3), timer unchanged.
    level = 3;
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lv.3');
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
    expect(hudTexts(hud)).toContain('Weapon: dual Lv.4');
    destroy(game);
  });

  it('shows no level suffix without a provider (backward compatible)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: rapid');
    expect(hudTexts(hud).some((t) => t.includes('Lv.'))).toBe(false);
    destroy(game);
  });
});
