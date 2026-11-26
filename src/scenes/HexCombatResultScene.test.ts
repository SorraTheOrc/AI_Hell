/**
 * Hex combat results dialog overlay — contract tests
 * (AH-0MWMGPTNF004EX3T, child of AH-0MWMFGXD6005WTMN).
 *
 * The overlay is the body-only results dialog the hex map presents after a
 * finished deployment. These tests pin the shipped overlay contract it
 * mirrors (`MineralChoiceScene` / `MiniBossWheelScene`):
 *
 * - the launcher hands over a heading plus ordered rows, rendered **verbatim**
 *   — the scene derives no reward, score, weakness or rule of its own, so it
 *   imports nothing from the hangar-war rules modules;
 * - one confirm input (`Enter`, `Space` or a pointer press) dismisses it, the
 *   optional `onDismiss` fires **exactly once**, and with it omitted the
 *   dialog simply closes;
 * - `autoConfirmMs > 0` auto-confirms after that delay so the attract/demo
 *   traversal cannot stall, while normal play waits for the player;
 * - it is boot-registered in `src/core/gameConfig.ts` and explicitly classified
 *   as non-capturable in `scripts/capture-scenes.mjs`, so the scene and
 *   capture registries cannot drift.
 *
 * The map-side landing (pausing the map, handing over the builder's view) is
 * the sibling item AH-0MWMGPV420013MGB and is pinned in
 * `src/scenes/HexMapScene.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { buildGameConfig } from '../core/gameConfig';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import {
  HEX_COMBAT_RESULT_CONFIRM_COPY,
  HEX_COMBAT_RESULT_DEFAULT_TITLE,
  HEX_COMBAT_RESULT_SCENE_KEY,
  HexCombatResultScene,
} from './HexCombatResultScene';

/** Minimal scene used as the boot target; the dialog is started on top. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HexCombatResultHarness');
  }
}

/** The rows a finished victory lands with (the builder's own output shape). */
const VICTORY_ROWS = [
  { key: 'outcome', text: 'VICTORY · SCORE 1200' },
  { key: 'salvage', text: 'SALVAGE BANKED: +120 MINERALS, +1 CORE' },
  { key: 'grant', text: 'GRANT CLAIMED: hull-2' },
  { key: 'win-bonus', text: 'WIN BONUS BANKED: +250 MINERALS' },
] as const;

/** Every rendered text child, joined — the dialog's whole on-screen copy. */
function screenText(scene: Phaser.Scene): string {
  return scene.children.list
    .filter(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text,
    )
    .map((child) => child.text)
    .join('\n');
}

/** The scene's rendered `▶ CONTINUE` row. */
function confirmRow(scene: Phaser.Scene): Phaser.GameObjects.Text {
  const row = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      child.text.startsWith(HEX_COMBAT_RESULT_CONFIRM_COPY),
  );
  if (!row) throw new Error('the dialog has no ▶ CONTINUE row');
  return row;
}

/** Emits one keydown on the overlay, as a player would. */
function pressKey(scene: Phaser.Scene, key: string): void {
  scene.input.keyboard!.emit('keydown', {
    key,
    repeat: false,
    preventDefault: () => {},
  } as KeyboardEvent);
}

describe('HexCombatResultScene', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots the dialog on top of a harness scene with the supplied payload. */
  async function bootDialog(
    data: Record<string, unknown>,
  ): Promise<HexCombatResultScene> {
    booted = await bootScene([HarnessScene, HexCombatResultScene]);
    booted.game.scene.start(HEX_COMBAT_RESULT_SCENE_KEY, data);
    await advanceGame(booted.game, 50);
    return booted.game.scene.getScene(
      HEX_COMBAT_RESULT_SCENE_KEY,
    ) as HexCombatResultScene;
  }

  it('is registered in the game config so the map can start it by key', () => {
    const config = buildGameConfig();
    expect(config.scene).toContain(HexCombatResultScene);
    expect(new HexCombatResultScene().sys.settings.key).toBe(
      HEX_COMBAT_RESULT_SCENE_KEY,
    );
    expect(HEX_COMBAT_RESULT_SCENE_KEY).toBe(HexCombatResultScene.name);
  });

  it('renders the heading and every row verbatim, in the order handed over', async () => {
    const scene = await bootDialog({
      origin: 'hex-map',
      title: 'SORTIE RESULTS',
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss: () => {},
    });

    expect(scene.getTitle()).toBe('SORTIE RESULTS');
    expect(scene.getRows()).toEqual(VICTORY_ROWS.map((row) => row.text));
    expect(scene.getOrigin()).toBe('hex-map');

    const text = screenText(scene);
    expect(text).toContain('SORTIE RESULTS');
    // Every supplied line is on screen exactly as handed over …
    for (const row of VICTORY_ROWS) {
      expect(text).toContain(row.text);
    }
    // … and in draw order, one labelled line per row.
    const heading = text.indexOf('SORTIE RESULTS');
    const positions = VICTORY_ROWS.map((row) => text.indexOf(row.text));
    expect(heading).toBeLessThan(positions[0]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // The rows are stacked, never overlapping.
    const layouts = scene.getRowLayouts();
    expect(layouts.map((row) => row.text)).toEqual(
      VICTORY_ROWS.map((row) => row.text),
    );
    for (let index = 1; index < layouts.length; index += 1) {
      expect(layouts[index].top).toBeGreaterThan(layouts[index - 1].bottom);
    }
  });

  it('accepts the pure builder view whole (title + ordered rows)', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      view: { title: 'SORTIE RESULTS', outcome: 'VICTORY', rows: VICTORY_ROWS },
      onDismiss,
    });

    expect(scene.getTitle()).toBe('SORTIE RESULTS');
    expect(scene.getRows()).toEqual(VICTORY_ROWS.map((row) => row.text));
    expect(screenText(scene)).toContain(
      'SALVAGE BANKED: +120 MINERALS, +1 CORE',
    );
    expect(scene.getDismissCallCount()).toBe(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('falls back to the fixed title when none is supplied', async () => {
    const scene = await bootDialog({ rows: ['DEFEAT · SCORE 42'] });

    expect(HEX_COMBAT_RESULT_DEFAULT_TITLE).toBe('SORTIE RESULTS');
    expect(scene.getTitle()).toBe(HEX_COMBAT_RESULT_DEFAULT_TITLE);
    expect(screenText(scene)).toContain('DEFEAT · SCORE 42');
  });

  it('dismisses from Enter and fires onDismiss exactly once', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      title: 'SORTIE RESULTS',
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
    });

    expect(scene.isConfirmed()).toBe(false);
    pressKey(scene, 'Enter');
    await advanceGame(booted!.game, 100);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(scene.getDismissCallCount()).toBe(1);
    expect(scene.isConfirmed()).toBe(true);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);

    // A second confirm cannot fire the callback twice.
    pressKey(scene, 'Enter');
    pressKey(scene, ' ');
    scene.input.emit('pointerdown', { x: 10, y: 10 });
    expect(scene.confirm()).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(scene.getDismissCallCount()).toBe(1);
  });

  it('dismisses from Space', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({ rows: ['DEFEAT · SCORE 42'], onDismiss });

    pressKey(scene, ' ');
    await advanceGame(booted!.game, 100);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
  });

  it('ignores keys that are not a confirm input', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({ rows: ['VICTORY · SCORE 10'], onDismiss });

    for (const key of ['Escape', 'a', 'ArrowDown']) pressKey(scene, key);
    await advanceGame(booted!.game, 200);

    expect(onDismiss).not.toHaveBeenCalled();
    expect(scene.isConfirmed()).toBe(false);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(true);
  });

  it('dismisses from a pointer press on the ▶ CONTINUE row', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
    });

    const confirm = confirmRow(scene);
    expect(confirm.text).toBe(HEX_COMBAT_RESULT_CONFIRM_COPY);
    confirm.emit('pointerdown');
    await advanceGame(booted!.game, 100);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
  });

  it('dismisses from a pointer press anywhere on the overlay', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
    });

    scene.input.emit('pointerdown', { x: 10, y: 10 });
    await advanceGame(booted!.game, 100);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
  });

  it('auto-confirms after the demo delay so the traversal cannot stall', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
      autoConfirmMs: 300,
    });

    await advanceGame(booted!.game, 150);
    expect(scene.isConfirmed()).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();

    await advanceGame(booted!.game, 300);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
  });

  it('accepts the map handoff alias autoDismissMs', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      view: { title: 'SORTIE RESULTS', rows: VICTORY_ROWS },
      onDismiss,
      autoDismissMs: 250,
    });

    await advanceGame(booted!.game, 400);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(scene.isConfirmed()).toBe(true);
  });

  it('waits for the player in normal play (no auto-confirm delay)', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
    });

    await advanceGame(booted!.game, 600);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(scene.isConfirmed()).toBe(false);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(true);
  });

  it('closes without a callback when onDismiss is omitted (isolated tests)', async () => {
    const scene = await bootDialog({ rows: ['VICTORY · SCORE 10'] });

    expect(scene.confirm()).toBe(true);
    await advanceGame(booted!.game, 100);

    expect(scene.isConfirmed()).toBe(true);
    expect(scene.getDismissCallCount()).toBe(1);
    expect(booted!.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
  });

  it('a pointer press cancels the pending demo timer (one dismissal only)', async () => {
    const onDismiss = vi.fn();
    const scene = await bootDialog({
      rows: VICTORY_ROWS.map((row) => row.text),
      onDismiss,
      autoConfirmMs: 300,
    });

    scene.input.emit('pointerdown', { x: 10, y: 10 });
    // Well past the demo delay: the cancelled timer must not fire again.
    await advanceGame(booted!.game, 600);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(scene.getDismissCallCount()).toBe(1);
  });

  it('derives no reward, score, weakness or rule of its own', () => {
    // The dialog draws only the rows it is handed, so it must not import the
    // capture cycle, the authored hex definitions or the hangar store — the
    // pure builder is the single source of every figure and rule.
    const source = readFileSync(
      resolve(process.cwd(), 'src/scenes/HexCombatResultScene.ts'),
      'utf8',
    );
    const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(specifiers.sort()).toEqual(['../core/constants', 'phaser'].sort());
  });
});
