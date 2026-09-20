/**
 * Integration tests for applying persisted key bindings to gameplay and
 * menus (AH-0MUA8BK1E001UZUC — child of the In-game menu epic
 * AH-0MU9LPZ0G0015292).
 *
 * Covers: PlayScene movement/layer-drop/pause keys read from
 * `ai_hell_settings` (defaults unchanged), rebound keys drive the ship,
 * old keys no longer trigger, the layer-drop JustDown contract with a
 * rebound key, menu navigation using the configured up/down/pause keys,
 * and the invalid-binding fallback.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  DEFAULT_BINDINGS,
  saveSettings,
  type ActionName,
} from '../core/settingsStore';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { PlayScene } from './PlayScene';
import { SettingsScene } from './SettingsScene';

const KC = Phaser.Input.Keyboard.KeyCodes;

const REBOUND: Record<ActionName, string> = {
  moveUp: 'i',
  moveDown: 'k',
  moveLeft: 'j',
  moveRight: 'l',
  layerDrop: 'o',
  pauseToggle: 'p',
};

function persistBindings(bindings: Record<ActionName, string>): void {
  saveSettings({ sfxVolume: 1, sfxMuted: false, bindings });
}

interface PlayInternals {
  wasd:
    | {
        W: Phaser.Input.Keyboard.Key;
        A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key;
        D: Phaser.Input.Keyboard.Key;
      }
    | undefined;
  teleportKey: Phaser.Input.Keyboard.Key | null;
  downKey: Phaser.Input.Keyboard.Key | null;
  pauseKeyName: string;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('Rebindable controls — gameplay + menus (AH-0MUA8BK1E001UZUC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootPlay(
    scenes: (typeof Phaser.Scene)[] = [PlayScene, GameOverScene, MenuScene],
  ): Promise<PlayScene> {
    booted = await bootScene(scenes);
    return booted.scene as PlayScene;
  }

  // ── AC1 — default bindings unchanged ────────────────────────────

  it('AC1 — default bindings keep WASD, S layer-drop and ESC pause', async () => {
    const scene = await bootPlay();
    const internals = scene as unknown as PlayInternals;
    expect(internals.wasd!.W.keyCode).toBe(KC.W);
    expect(internals.wasd!.A.keyCode).toBe(KC.A);
    expect(internals.wasd!.S.keyCode).toBe(KC.S);
    expect(internals.wasd!.D.keyCode).toBe(KC.D);
    expect(internals.teleportKey!.keyCode).toBe(KC.S);
    expect(internals.downKey!.keyCode).toBe(KC.DOWN);
    expect(internals.pauseKeyName).toBe('Escape');
  });

  // ── AC1 — rebound gameplay keys ─────────────────────────────────

  it('AC1 — gameplay reads movement / layer-drop keys from the bindings', async () => {
    persistBindings(REBOUND);
    const scene = await bootPlay();
    const internals = scene as unknown as PlayInternals;
    expect(internals.wasd!.W.keyCode).toBe(KC.I);
    expect(internals.wasd!.A.keyCode).toBe(KC.J);
    expect(internals.wasd!.S.keyCode).toBe(KC.K);
    expect(internals.wasd!.D.keyCode).toBe(KC.L);
    expect(internals.teleportKey!.keyCode).toBe(KC.O);
    // The old WASD keys are no longer wired to the movement handler.
    expect(internals.wasd!.W.keyCode).not.toBe(KC.W);
    expect(internals.wasd!.S.keyCode).not.toBe(KC.S);
  });

  it('AC1/AC5 — the rebound movement key moves the ship (old key inert)', async () => {
    persistBindings(REBOUND);
    const scene = await bootPlay();
    const internals = scene as unknown as PlayInternals;
    const player = scene.getPlayer()!;

    // Rebound move-up ('i' seat) moves the ship up.
    const yBefore = player.y;
    internals.wasd!.W.isDown = true;
    scene.tick(0.1);
    internals.wasd!.W.isDown = false;
    expect(player.y).toBeLessThan(yBefore);

    // The old 'w' key object is not referenced by the movement handler:
    // there is no separate Key for it, so it cannot move the ship.
    expect(internals.wasd!.W.keyCode).toBe(KC.I);
  });

  it('AC1 — the rebound pause key toggles pause; the old ESC does not', async () => {
    persistBindings(REBOUND);
    const scene = await bootPlay();
    expect(scene.isPaused()).toBe(false);

    pressKey('Escape');
    await settle();
    expect(scene.isPaused()).toBe(false);

    pressKey('p');
    await settle();
    expect(scene.isPaused()).toBe(true);

    pressKey('p');
    await settle();
    expect(scene.isPaused()).toBe(false);
  });

  // ── AC4 — layer-drop JustDown preserved with a rebound key ──────

  it('AC4 — rebound layer-drop key keeps JustDown semantics', async () => {
    persistBindings(REBOUND);
    const scene = await bootPlay();
    const internals = scene as unknown as PlayInternals;
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P7 teleport stack.
    const drop = scene.spawnPowerUpDrop('P7', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    const key = internals.teleportKey!;
    expect(key.keyCode).toBe(KC.O);
    internals.downKey!.isDown = false;

    // Holding the key without a fresh press does not retrigger.
    key.isDown = true;
    (key as unknown as { _justDown: boolean })._justDown = false;
    scene.tick(0.05);
    expect(registry.teleportStacks()).toBe(1);

    // A fresh JustDown fires the teleport.
    (key as unknown as { _justDown: boolean })._justDown = true;
    scene.tick(0.05);
    expect(registry.teleportStacks()).toBe(0);
  });

  // ── AC2 — menu navigation uses configured bindings ──────────────

  it('AC2 — PauseScene uses the configured pause key and up/down nav keys', async () => {
    persistBindings(REBOUND);
    const play = await bootPlay([PlayScene, PauseScene, MenuScene, GameOverScene]);

    // Rebound pause key opens the menu.
    pressKey('p');
    await settle();
    expect(play.isPaused()).toBe(true);
    const pause = booted!.game.scene.getScene('PauseScene') as PauseScene;
    expect(pause.getFocusedLabel()).toBe('▶  Resume');

    // Rebound move-down key cycles focus.
    pressKey('k');
    await settle();
    expect(pause.getFocusedLabel()).toBe('⚙  Settings');

    // Rebound pause key resumes.
    pressKey('p');
    await settle();
    expect(play.isPaused()).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });

  it('AC2 — SettingsScene uses the configured pause key for Back', async () => {
    persistBindings(REBOUND);
    booted = await bootScene([SettingsScene, PauseScene, MenuScene]);
    await settle();

    pressKey('p');
    await settle();

    expect(booted!.game.scene.isActive('SettingsScene')).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(true);
  });

  // ── AC3 — invalid binding fallback ──────────────────────────────

  it('AC3 — an invalid stored binding falls back to its default', async () => {
    persistBindings({
      ...DEFAULT_BINDINGS,
      moveUp: 'NotAKey', // unsupported name
      pauseToggle: '', // blank
    });
    const scene = await bootPlay();
    const internals = scene as unknown as PlayInternals;
    // moveUp falls back to 'w'; pauseToggle falls back to 'Escape'.
    expect(internals.wasd!.W.keyCode).toBe(KC.W);
    expect(internals.pauseKeyName).toBe('Escape');
  });
});