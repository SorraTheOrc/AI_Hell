import { describe, it, expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { HUD, HUD_DEPTH } from './HUD';
import { EffectsRegistry } from '../powerups/effects';
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
async function bootWithHUD(registry?: EffectsRegistry) {
  const { game, scene } = await bootScene([BareScene]);
  const hud = new HUD(scene, registry ?? null);
  return { game, scene, hud };
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
    reg.applyCollect('P9');
    reg.applyCollect('P9');
    reg.applyCollect('P9');
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
    reg.applyCollect('P9');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('x1');

    reg.applyCollect('P9');
    reg.applyCollect('P9');
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('x3');
    destroy(game);
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

    reg.applyCollect('P5'); // re-collect → refresh to full 10 s
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('10s');
    destroy(game);
  });

  it('adds a row when a new effect is collected', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);

    reg.applyCollect('P5');
    reg.applyCollect('P9');
    reg.applyCollect('P9');
    hud.refresh();
    const rows = hud.getRows();
    expect(rows).toHaveLength(2); // P5 timed row + P9 stack row
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('P5');
    expect(ids).toContain('P9');
    destroy(game);
  });
});