/**
 * Elite aura + `ELITE` tag rendering tests
 * (AH-0MWU666IS008JOR3 AC4/AC5; folded test child AH-0MWU65X6C007JBTL).
 *
 * The elite must be legible without relying on colour: two concentric aura
 * rings give it a shape cue, and a black-badged white `ELITE` tag tracks the
 * hull. The tag is a container child, so it follows the enemy automatically and
 * disappears exactly when the hull dies (`destroySilently` is the single death
 * mark). A small luminance helper proves the treatment survives a grayscale
 * render rather than depending on hue.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import type { FormationOffset } from '../utils/formations';
import {
  BaseEnemy,
  ELITE_AURA_COLOR,
  ELITE_AURA_RING_COUNT,
  ELITE_TAG_BACKGROUND_COLOR,
  ELITE_TAG_TEXT,
  ELITE_TAG_TEXT_COLOR,
  type BaseEnemyConfig,
} from './BaseEnemy';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('EliteHarnessScene');
  }
}

/** Minimal concrete enemy used to exercise the shared elite decoration. */
class TestEnemy extends BaseEnemy {
  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    this.bodyGraphics.fillStyle(0x00ff00, 1);
    this.bodyGraphics.fillCircle(0, 0, 8);
  }

  /** Attaches the shared layers (normally a subclass constructor's job). */
  mount(): void {
    this.addSharedGraphics();
  }
}

const OFFSET: FormationOffset = { row: 0, col: 0 };

function makeEnemy(scene: Phaser.Scene): TestEnemy {
  const config: BaseEnemyConfig = {
    formationOffset: OFFSET,
    size: 16,
    color: 0x00ff00,
  };
  const enemy = new TestEnemy(scene, 100, 100, config);
  enemy.mount();
  return enemy;
}

/** sRGB relative luminance (0–1) of a `0xRRGGBB` colour. */
function luminance(colour: number): number {
  const channel = (shift: number): number => {
    const value = ((colour >> shift) & 0xff) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG contrast ratio between two colours after a grayscale conversion. */
function grayscaleContrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexColour(css: string): number {
  return Number.parseInt(css.replace('#', ''), 16);
}

describe('BaseEnemy elite decoration (AH-0MWU666IS008JOR3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('an ordinary enemy carries no elite decoration', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);

    expect(enemy.eliteBehaviour).toBeUndefined();
    expect(enemy.eliteDecoration).toEqual({
      rings: 0,
      tagText: '',
      tagVisible: false,
      tagOffsetY: 0,
    });
  });

  it('elevating the hull draws the aura rings and a hull-tracking ELITE tag', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    const childrenBefore = enemy.list.length;

    enemy.setEliteBehaviour('splitter');

    const decoration = enemy.eliteDecoration;
    expect(decoration.rings).toBe(ELITE_AURA_RING_COUNT);
    expect(decoration.tagText).toBe(ELITE_TAG_TEXT);
    expect(decoration.tagVisible).toBe(true);
    // The aura layer and tag are container children (so the tag tracks the
    // hull). The tag sits above the hull centre and its offset is unchanged
    // when the hull moves (AC4).
    expect(enemy.list.length).toBeGreaterThan(childrenBefore);
    expect(decoration.tagOffsetY).toBeLessThan(0);
    enemy.setPosition(400, 300);
    expect(enemy.eliteDecoration.tagOffsetY).toBe(decoration.tagOffsetY);
  });

  it('the tag and aura disappear exactly when the elite dies (AC4)', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    enemy.setEliteBehaviour('volatile');
    expect(enemy.eliteDecoration.tagVisible).toBe(true);

    enemy.destroySilently();

    expect(enemy.alive).toBe(false);
    expect(enemy.eliteDecoration.rings).toBe(0);
    expect(enemy.eliteDecoration.tagVisible).toBe(false);
  });

  it('survives a grayscale render: shape (rings) and badge, not colour alone (AC5)', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    enemy.setEliteBehaviour('reinforced');

    // The shape cue survives desaturation: two concentric rings are drawn.
    expect(enemy.eliteDecoration.rings).toBe(ELITE_AURA_RING_COUNT);
    // The aura ring stays well above the black playfield in grayscale.
    expect(luminance(ELITE_AURA_COLOR)).toBeGreaterThan(0.5);
    expect(grayscaleContrast(ELITE_AURA_COLOR, 0x000000)).toBeGreaterThan(4.5);
    // The `ELITE` badge is a white-on-black pair: maximum grayscale contrast.
    expect(
      grayscaleContrast(
        hexColour(ELITE_TAG_TEXT_COLOR),
        hexColour(ELITE_TAG_BACKGROUND_COLOR),
      ),
    ).toBeGreaterThan(7);
  });

  it('destroys the decoration layers without leaking when the entity is removed', async () => {
    booted = await bootScene([HarnessScene]);
    const enemy = makeEnemy(booted.scene);
    enemy.setEliteBehaviour('splitter');

    expect(() => enemy.destroy()).not.toThrow();
    expect(enemy.eliteDecoration.rings).toBe(0);
    expect(enemy.eliteDecoration.tagText).toBe('');
  });
});
