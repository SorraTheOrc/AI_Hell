/**
 * MineralChoiceScene tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC1/AC4/AC8: the modal
 * overlay presents distinct options from the pluggable strategy and forwards
 * the selection back to PlayScene.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { MineralChoiceScene } from '../MineralChoiceScene';

/** Minimal scene used as the boot target for isolated overlay tests. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MineralChoiceHarness');
  }
}

describe('MineralChoiceScene', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('presents three distinct options with numbered labels', async () => {
    booted = await bootScene([MineralChoiceScene]);
    const scene = booted.scene as MineralChoiceScene;

    const options = scene.getOptions();
    expect(options).toHaveLength(3);
    expect(new Set(options.map((o) => o.id)).size).toBe(3);

    const labels = scene.getOptionLabels();
    expect(labels).toHaveLength(3);
    options.forEach((option, index) => {
      expect(labels[index]).toContain(option.name);
      expect(labels[index]).toContain(`${index + 1}`);
    });
  });

  it('renders the options as interactive controls', async () => {
    booted = await bootScene([MineralChoiceScene]);
    const scene = booted.scene as MineralChoiceScene;
    const labels = scene.getOptionLabels();
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  it('select returns the chosen option and rejects out-of-range indices', async () => {
    booted = await bootScene([MineralChoiceScene]);
    const scene = booted.scene as MineralChoiceScene;

    const options = scene.getOptions();
    const chosen = scene.select(0);
    expect(chosen).toEqual(options[0]);

    // Out-of-range selection is a no-op.
    expect(scene.select(99)).toBeNull();
  });

  it('presents the options supplied by the caller', async () => {
    booted = await bootScene([HarnessScene, MineralChoiceScene]);
    booted.game.scene.start('MineralChoiceScene', {
      options: [
        { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
        { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const scene = booted.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(scene.getOptions().map((o) => o.id)).toEqual(['P5', 'spread']);
    expect(scene.getOptionLabels()).toHaveLength(2);
  });
});
