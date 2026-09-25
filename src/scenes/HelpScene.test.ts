/**
 * Scene tests for the gym help overlay (AH-0MUAYB67I002REOZ).
 *
 * Covers: the opaque full-screen replacement, the per-drop icon + name +
 * description rows, the default-focused `Close` control, and the
 * `?` / `Close` / ESC close paths (which resume the paused gym, with ESC
 * never reaching the gym's menu handler while the overlay is open).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  addHelpButton,
  getHelpEntry,
  type GymHelpHandle,
} from '../utils/gymHelp';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../utils/gymNavigation';
import { HelpScene } from './HelpScene';
import { MenuScene } from './MenuScene';

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Gym-like host scene exercising the real open/close lifecycle. */
class HelpHostStub extends Phaser.Scene {
  handle: GymHelpHandle | null = null;

  constructor() {
    super('HelpHostStub');
  }

  create(): void {
    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);
    this.handle = addHelpButton(this, {
      gymKey: 'HelpHostStub',
      drops: ['P5', 'P8', 'P9'],
    });
  }
}

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('HelpScene — overlay content and lifecycle (AH-0MUAYB67I002REOZ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootAndOpen(): Promise<{ host: HelpHostStub; help: HelpScene }> {
    booted = await bootScene([HelpHostStub, HelpScene, MenuScene]);
    const host = booted.scene as HelpHostStub;
    host.handle!.openHelp();
    await settle();
    const help = booted.game.scene.getScene('HelpScene') as HelpScene;
    return { host, help };
  }

  it('AC5 — renders an opaque full-screen replacement with a titled header', async () => {
    const { help } = await bootAndOpen();

    const background = help.children.list.find(
      (c): c is Phaser.GameObjects.Rectangle =>
        c instanceof Phaser.GameObjects.Rectangle &&
        c.width === GAME_WIDTH &&
        c.height === GAME_HEIGHT,
    );
    expect(background).toBeDefined();
    expect(background!.fillAlpha).toBe(1);

    const title = help.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text.startsWith('HELP'),
    );
    expect(title).toBeDefined();
    expect(title!.text).toContain('Help Host Stub');
  });

  it('AC2 — lists exactly the drops of the originating gym', async () => {
    const { help } = await bootAndOpen();

    expect(help.getGymKey()).toBe('HelpHostStub');
    expect(help.getEntries().map((e) => e.id)).toEqual(['P5', 'P8', 'P9']);

    // Each row's name + description are rendered as text.
    const texts = help.children.list
      .filter((c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text)
      .map((t) => t.text);
    for (const id of ['P5', 'P8', 'P9'] as const) {
      const entry = getHelpEntry(id);
      expect(texts).toContain(entry.name);
      expect(texts).toContain(entry.description);
    }
  });

  it('AC2 — draws the code-drawn icon for every requested drop', async () => {
    const { help } = await bootAndOpen();
    const drawnIcons = help.children.list.filter(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics &&
        c.commandBuffer.length > 0,
    );
    expect(drawnIcons.length).toBeGreaterThanOrEqual(3);
  });

  it('AC4 — the Close control is focused by default and keyboard-operable', async () => {
    const { help } = await bootAndOpen();
    expect(help.getControlCount()).toBe(1);
    expect(help.getFocusedLabel()).toBe('Close');
    expect(help.getCloseControl()).not.toBeNull();

    // Enter activates the focused Close control → closes the overlay.
    pressKey('Enter');
    await settle();
    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
  });

  it('AC4 — the Close control closes and resumes the gym on pointerdown', async () => {
    const { host, help } = await bootAndOpen();
    expect(booted!.game.scene.isPaused('HelpHostStub')).toBe(true);

    help.getCloseControl()!.emit('pointerdown');
    await settle();

    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(booted!.game.scene.isPaused('HelpHostStub')).toBe(false);
    expect(host.sys.isActive()).toBe(true);
  });

  it('AC4 — ? closes the overlay and resumes the gym', async () => {
    const { host } = await bootAndOpen();

    pressKey('?');
    await settle();

    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(host.sys.isActive()).toBe(true);
  });

  it('AC4 — ESC closes the overlay and resumes the gym', async () => {
    const { host } = await bootAndOpen();

    pressKey('Escape');
    await settle();

    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(host.sys.isActive()).toBe(true);
  });

  it('AC4 — ESC while help is open does not reach the menu; once closed it does', async () => {
    const { host } = await bootAndOpen();
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    // ESC closes help, does NOT exit to the menu.
    pressKey('Escape');
    await settle();
    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
    expect(host.sys.isActive()).toBe(true);

    // A fresh ESC (help now closed) returns to the menu as before.
    pressKey('Escape');
    await settle();
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('opening help repeatedly is idempotent (no stacked overlays)', async () => {
    const { host } = await bootAndOpen();

    // A second open attempt while already open is a no-op.
    host.handle!.openHelp();
    await settle();
    expect(booted!.game.scene.isActive('HelpScene')).toBe(true);
    expect(booted!.game.scene.isPaused('HelpHostStub')).toBe(true);
  });
});
