/**
 * Unit tests for the shared gym help helper (AH-0MUAYB67I002REOZ).
 *
 * Covers: catalogue description coverage (AC3), the id → name/description/
 * icon lookup shared by the button and overlay, and the button wiring
 * (placement next to `← INDEX`, pointer/`?` open → pause gym + launch
 * `HelpScene`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { POWER_UP_CATALOGUE, type PowerUpId } from '../powerups/types';
import { RESET_DROP, WEAPON_CATALOGUE, type WeaponId } from './weapons';
import {
  addHelpButton,
  getHelpEntries,
  getHelpEntry,
  HELP_BUTTON_LABEL,
  type GymHelpHandle,
  type HelpDropId,
} from './gymHelp';
import { addBackToIndexButton, BACK_TO_INDEX_LABEL } from './gymNavigation';
import { HelpScene } from '../scenes/HelpScene';

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Minimal scene used only to allocate Graphics objects. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareScene' });
  }
}

/** Minimal host scene exercising the shared helper. */
class HelpHostStub extends Phaser.Scene {
  handle: GymHelpHandle | null = null;

  constructor() {
    super('HelpHostStub');
  }

  create(): void {
    addBackToIndexButton(this);
    this.handle = addHelpButton(this, {
      gymKey: 'HelpHostStub',
      drops: ['P5', 'P8', 'P9'],
    });
  }
}

describe('gymHelp — catalogue descriptions are the single source of truth (AC3)', () => {
  it('every POWER_UP_CATALOGUE entry exposes a non-empty description', () => {
    for (const entry of Object.values(POWER_UP_CATALOGUE)) {
      expect(entry.description, `P-entry ${entry.id}`).toBeTruthy();
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('every WEAPON_CATALOGUE entry exposes a non-empty description', () => {
    for (const entry of Object.values(WEAPON_CATALOGUE)) {
      expect(entry.description, `weapon ${entry.id}`).toBeTruthy();
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('the Reset drop exposes a non-empty description', () => {
    expect(RESET_DROP.name).toBe('Reset');
    expect(RESET_DROP.description.trim().length).toBeGreaterThan(0);
  });
});

describe('gymHelp — id → { name, description, drawIcon } lookup', () => {
  it('resolves power-up rows from POWER_UP_CATALOGUE', () => {
    const ids: PowerUpId[] = ['P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'];
    for (const id of ids) {
      const help = getHelpEntry(id);
      expect(help.id).toBe(id);
      expect(help.name).toBe(POWER_UP_CATALOGUE[id].name);
      expect(help.description).toBe(POWER_UP_CATALOGUE[id].description);
    }
  });

  it('resolves weapon rows from WEAPON_CATALOGUE, including cannon', () => {
    const ids: WeaponId[] = ['cannon', 'spread', 'dual', 'rapid'];
    for (const id of ids) {
      const help = getHelpEntry(id);
      expect(help.name).toBe(WEAPON_CATALOGUE[id].name);
      expect(help.description).toBe(WEAPON_CATALOGUE[id].description);
    }
  });

  it('resolves the reset drop from RESET_DROP', () => {
    const help = getHelpEntry('reset');
    expect(help.name).toBe(RESET_DROP.name);
    expect(help.description).toBe(RESET_DROP.description);
  });

  it('preserves the requested order in getHelpEntries', () => {
    const drops: HelpDropId[] = ['cannon', 'spread', 'reset', 'P5'];
    expect(getHelpEntries(drops).map((e) => e.id)).toEqual(drops);
  });
});

describe('gymHelp — every resolved entry draws a code-drawn icon', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('draws into a Graphics buffer for every drop id', async () => {
    booted = await bootScene([BareScene]);
    const graphics = (booted.scene as Phaser.Scene).add.graphics();
    const drops: HelpDropId[] = [
      'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9',
      'cannon', 'spread', 'dual', 'rapid', 'reset',
    ];
    for (const id of drops) {
      graphics.clear();
      getHelpEntry(id).drawIcon(graphics, 0, 0, 12);
      expect(graphics.commandBuffer.length, `icon for ${id}`).toBeGreaterThan(0);
    }
  });
});

describe('gymHelp — Help (?) button wiring', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootHost(): Promise<HelpHostStub> {
    booted = await bootScene([HelpHostStub, HelpScene]);
    return booted.scene as HelpHostStub;
  }

  it('renders a Help (?) button immediately left of ← INDEX without overlap', async () => {
    const host = await bootHost();
    const index = host.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === BACK_TO_INDEX_LABEL,
    );
    const help = host.handle!.button;

    expect(index).toBeDefined();
    expect(help.text).toBe(HELP_BUTTON_LABEL);
    // Both are right-aligned; the help button's right edge sits left of the
    // index button's left edge, so they never overlap.
    const helpRight = help.x;
    const indexLeft = index!.x - index!.width;
    expect(helpRight).toBeLessThanOrEqual(indexLeft);
  });

  it('clicking Help (?) pauses the host gym and launches HelpScene (AC1)', async () => {
    const host = await bootHost();
    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);

    host.handle!.button.emit('pointerdown');
    await settle();

    expect(booted!.game.scene.isPaused('HelpHostStub')).toBe(true);
    expect(booted!.game.scene.isActive('HelpScene')).toBe(true);
    expect((booted!.game.scene.getScene('HelpScene') as HelpScene).getGymKey()).toBe(
      'HelpHostStub',
    );
  });

  it('pressing ? opens the same help overlay (AC1)', async () => {
    const host = await bootHost();
    host.input.keyboard!.emit('keydown', { key: '?' } as KeyboardEvent);
    await settle();

    expect(booted!.game.scene.isPaused('HelpHostStub')).toBe(true);
    expect(booted!.game.scene.isActive('HelpScene')).toBe(true);
  });

  it('exposes the button via the host accessor', async () => {
    const host = await bootHost();
    expect(host.handle).not.toBeNull();
    expect(host.handle!.button.active).toBe(true);
  });
});
