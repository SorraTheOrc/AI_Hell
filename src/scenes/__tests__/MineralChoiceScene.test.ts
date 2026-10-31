/**
 * MineralChoiceScene tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC1/AC4/AC8: the modal
 * overlay presents distinct options from the pluggable strategy and forwards
 * the selection back to PlayScene.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import * as effects from '../../audio/effects';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../../core/rules';
import {
  CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
  CHOICE_DESCRIPTION_MAX_LINES,
} from '../core/choiceDescriptionWrap';
import { HOLD_FULL_COUNTDOWN_DURATION_MS } from '../core/holdFullCountdown';
import { advanceGame, bootScene, BootedGame } from '../../test/gameHarness';
import { RecordingSfxProvider } from '../../test/audioTestDouble';
import type { ChoiceOption } from '../../powerups/choice';
import { buildOwnedLoadout, type OwnedLoadoutRow } from '../../powerups/ownedLoadout';
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
    effects._resetAudioContextForTests();
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
        { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
        { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
      ],
    });
    await advanceGame(booted!.game, 50);

    const scene = booted.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(scene.getOptions().map((o) => o.id)).toEqual(['speed_boost', 'spread']);
    expect(scene.getOptionLabels()).toHaveLength(2);
  });

  describe('owned permanent loadout panel (AH-0MVCRKAPL000L68Y)', () => {
    /** Boots the overlay with the supplied permanent loadout rows. */
    async function bootWithOwned(
      ownedUpgrades?: readonly OwnedLoadoutRow[],
    ): Promise<MineralChoiceScene> {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'spread', name: 'Spread Shot Lv.3', kind: 'weapon-level' }],
        ...(ownedUpgrades === undefined ? {} : { ownedUpgrades }),
      });
      await advanceGame(booted.game, 50);
      return booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
    }

    it('renders one Lv.N row per permanently owned item in the top-left', async () => {
      const rows = buildOwnedLoadout(
        [{ id: 'shield', level: 3 }],
        [
          { id: 'spread', level: 2 },
          { id: 'rapid', level: 1 },
        ],
      );
      const scene = await bootWithOwned(rows);

      expect(scene.getOwnedUpgradeLines()).toEqual([
        'Spread Shot Lv.2',
        'Rapid Fire Lv.1',
        'Shield Lv.3',
      ]);
      const layout = scene.getOwnedUpgradePanelLayout()!;
      expect(layout.heading).toBe('YOUR UPGRADES');
      // Top-left of the playfield.
      expect(layout.left).toBeLessThan(GAME_WIDTH / 4);
      expect(layout.top).toBeLessThan(GAME_HEIGHT / 4);
      // Never collides with the centred option column (AC5).
      expect(layout.bottom).toBeLessThan(scene.getRowLayout()[0].top);
    });

    it('renders the "none yet" empty state when nothing is owned permanently', async () => {
      const scene = await bootWithOwned([]);

      expect(scene.getOwnedUpgradeLines()).toEqual([]);
      expect(scene.getOwnedUpgradePanelLayout()?.heading).toBe(
        'YOUR UPGRADES — none yet',
      );
    });

    it('omits the panel entirely when the launcher supplies no loadout', async () => {
      const scene = await bootWithOwned(undefined);

      // Backward compatible: isolated callers that pass only `options` keep
      // the pre-existing layout, with no panel and no empty-state heading.
      expect(scene.getOwnedUpgradePanelLayout()).toBeNull();
      expect(scene.getOwnedUpgradeLines()).toEqual([]);
      expect(scene.getOptionLabels()).toHaveLength(1);
    });

    it('tears the panel down with the rest of the choice UI', async () => {
      const scene = await bootWithOwned(
        buildOwnedLoadout([], [{ id: 'spread', level: 2 }]),
      );
      expect(scene.getOwnedUpgradeLines()).toEqual(['Spread Shot Lv.2']);

      scene.select(0);

      expect(scene.getOwnedUpgradePanelLayout()).toBeNull();
      expect(scene.getOwnedUpgradeLines()).toEqual([]);
      expect(scene.isChoiceScreenVisible()).toBe(false);
    });
  });

  describe('upgrade summary and New badge (AH-0MUU1GOAU007RFVR)', () => {
    it('renders a change-summary detail line for weapon-level options', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'spread',
            name: 'Spread Shot Lv.3',
            kind: 'weapon-level',
            level: 3,
            changeSummary: '+1 Projectiles',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const details = scene.getDetailLines();
      expect(details).toHaveLength(1);
      expect(details[0]).toBe('+1 Projectiles');
      // Primary label is unchanged.
      expect(scene.getOptionLabels()[0]).toContain('Spread Shot Lv.3');
    });

    it('renders a "New" badge for options marked isNew', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'nova',
            name: 'Nova',
            kind: 'weapon',
            isNew: true,
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const details = scene.getDetailLines();
      expect(details).toHaveLength(1);
      expect(details[0]).toBe('\u2605 New');
    });

    it('renders no detail line when neither changeSummary nor isNew is set', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDetailLines()).toHaveLength(0);
    });

    it('shows both a change summary and no New badge for owned weapons', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'spread',
            name: 'Spread Shot Lv.3',
            kind: 'weapon-level',
            level: 3,
            changeSummary: '+1 Projectiles',
            isNew: false,
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const details = scene.getDetailLines();
      expect(details).toHaveLength(1);
      expect(details[0]).toBe('+1 Projectiles');
      // "New" takes priority over a summary when both are set.
    });

    it('"New" badge takes display priority over changeSummary', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'spread',
            name: 'Spread Shot',
            kind: 'weapon',
            isNew: true,
            changeSummary: '+1 Projectiles',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDetailLines()[0]).toBe('\u2605 New');
    });
  });

  describe('option descriptions (AH-0MV2N2591007UGPD)', () => {
    it('AC2 — renders a description line as part of a three-part block', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'spread',
            name: 'Spread Shot Lv.3',
            kind: 'weapon-level',
            level: 3,
            description:
              'Adds a 3-bullet fan (\u221230\u00b0/0\u00b0/+30\u00b0).',
            changeSummary: '+1 Projectiles',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      // Name label unchanged; description and detail are separate lines with
      // the existing change-summary contract intact.
      expect(scene.getOptionLabels()[0]).toContain('Spread Shot Lv.3');
      expect(scene.getDescriptionLines()).toEqual([
        'Adds a 3-bullet fan (\u221230\u00b0/0\u00b0/+30\u00b0).',
      ]);
      expect(scene.getDetailLines()).toEqual(['+1 Projectiles']);
    });

    it('AC2 — shows a New option\u2019s description above its \u2605 New badge', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'nova',
            name: 'Nova',
            kind: 'weapon',
            isNew: true,
            description:
              'AOE: an expanding ring around the ship damages every enemy and clears bullets within its radius.',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDescriptionLines()).toHaveLength(1);
      expect(scene.getDescriptionLines()[0]).toContain('expanding ring');
      expect(scene.getDetailLines()).toEqual(['\u2605 New']);
    });

    it('AC6 — omits the description line when an option has none (no empty line)', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDescriptionLines()).toEqual([]);
      expect(scene.getDetailLines()).toEqual([]);
      expect(scene.getOptionLabels()).toHaveLength(1);
    });
  });

  describe('two-line description area (AH-0MVBLBSG3002WHBI)', () => {
    /** The longest description in the shared catalogue (Teleport, 210 chars). */
    const LONGEST_COPY =
      'Stores up to 3 uses; when the ship is in danger, one is spent automatically to warp to the nearest safe spot and grant a short Phase Shift on arrival. Teleporting can be disorienting — keep your wits about you.';

    it('AC1/AC7 — wraps the longest catalogue copy onto two lines inside the playfield', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'teleport',
            name: 'Teleport',
            kind: 'powerup',
            description: LONGEST_COPY,
            changeSummary: 'Permanent for this run',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      // AC4: the public copy contract still returns the catalogue copy.
      expect(scene.getDescriptionLines()).toEqual([LONGEST_COPY]);

      const rendered = scene.getDescriptionRenderedLines();
      expect(rendered).toHaveLength(1);
      expect(rendered[0]).toHaveLength(CHOICE_DESCRIPTION_MAX_LINES);
      expect(rendered[0].join(' ')).toBe(LONGEST_COPY);
      for (const line of rendered[0]) {
        expect(line.length).toBeLessThanOrEqual(
          CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
        );
      }

      const [row] = scene.getRowLayout();
      expect(row.description).not.toBeNull();
      expect(row.description?.lines).toBe(CHOICE_DESCRIPTION_MAX_LINES);
      // The description sits below the name and above the change summary.
      expect(row.description!.top).toBeGreaterThanOrEqual(row.name.bottom);
      expect(row.description!.bottom).toBeLessThanOrEqual(row.detail!.top);
      // Two wrapped lines never leave the 960 x 540 playfield.
      expect(row.description!.left).toBeGreaterThanOrEqual(0);
      expect(row.description!.right).toBeLessThanOrEqual(GAME_WIDTH);
      expect(row.bottom).toBeLessThanOrEqual(GAME_HEIGHT);
    });

    it('AC3 — truncates copy longer than two lines with an ellipsis and keeps it on screen', async () => {
      const overlong = Array.from(
        { length: 60 },
        (_, index) => `word${index}`,
      ).join(' ');
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'teleport',
            name: 'Teleport',
            kind: 'powerup',
            description: overlong,
            changeSummary: 'Permanent for this run',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const rendered = scene.getDescriptionRenderedLines()[0];
      expect(rendered).toHaveLength(CHOICE_DESCRIPTION_MAX_LINES);
      expect(rendered[1].endsWith('…')).toBe(true);
      for (const line of rendered) {
        expect(line.length).toBeLessThanOrEqual(
          CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
        );
      }

      const [row] = scene.getRowLayout();
      expect(row.description!.bottom).toBeLessThanOrEqual(row.detail!.top);
      expect(row.bottom).toBeLessThanOrEqual(GAME_HEIGHT);
    });

    it('AC4/AC7 — one-line descriptions stay one line; no description draws no area', async () => {
      const shortCopy = 'Adds a 3-bullet fan (−30°/0°/+30°).';
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'spread',
            name: 'Spread Shot',
            kind: 'weapon',
            description: shortCopy,
            changeSummary: '+1 Projectiles',
          },
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDescriptionLines()).toEqual([shortCopy]);
      expect(scene.getDescriptionRenderedLines()).toEqual([[shortCopy]]);

      const [shortRow, blankRow] = scene.getRowLayout();
      expect(shortRow.description!.lines).toBe(1);
      expect(blankRow.description).toBeNull();
      expect(blankRow.detail).toBeNull();
      // No description: the row is just the name, with no phantom area.
      expect(blankRow.bottom).toBe(blankRow.name.bottom);
      expect(blankRow.top).toBe(blankRow.name.top);
    });

    it('AC2/AC7 — mixed one- and two-line rows never overlap vertically', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          {
            id: 'teleport',
            name: 'Teleport',
            kind: 'powerup',
            description: LONGEST_COPY,
            changeSummary: 'Permanent for this run',
          },
          {
            id: 'noval',
            name: 'Nova',
            kind: 'weapon',
            description: 'AOE: an expanding ring around the ship.',
            isNew: true,
          },
          {
            id: 'spread',
            name: 'Spread Shot Lv.3',
            kind: 'weapon-level',
            level: 3,
            description:
              'Three bullets in a widening fan; every level adds another projectile and a little more spread, so the fan covers a wider arc.',
            changeSummary: '+1 Projectiles',
          },
        ],
      });
      await advanceGame(booted!.game, 50);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const rows = scene.getRowLayout();
      expect(rows).toHaveLength(3);
      expect(rows[0].description!.lines).toBe(2);
      expect(rows[1].description!.lines).toBe(1);
      expect(rows[2].description!.lines).toBe(2);

      for (const row of rows) {
        expect(row.name.bottom).toBeLessThanOrEqual(row.description!.top);
        expect(row.description!.bottom).toBeLessThanOrEqual(row.detail!.top);
        expect(row.top).toBeGreaterThanOrEqual(0);
        expect(row.bottom).toBeLessThanOrEqual(GAME_HEIGHT);
      }
      for (let i = 1; i < rows.length; i += 1) {
        // Strictly separated: consecutive blocks never collide.
        expect(rows[i].top).toBeGreaterThan(rows[i - 1].bottom);
      }
    });
  });

  describe('demo auto-select (AH-0MUXXQ1MN002RXGB)', () => {
    it('AC4 — auto-selects the first option after the delay', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      const calls: number[] = [];
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
          { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        ],
        autoSelectMs: 40,
        onSelect: (index: number) => calls.push(index),
      });
      await advanceGame(booted!.game, 250);

      // The auto-select records the choice and starts the 3-2-1 countdown;
      // the choice is applied when the countdown completes. Drive the
      // countdown deterministically (one big frame).
      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      scene.update(0, HOLD_FULL_COUNTDOWN_DURATION_MS);
      expect(calls).toEqual([0]);
    });

    it('auto-selects a preferred option index when one is supplied (AH-0MV03GXZQ00801T4)', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      const calls: number[] = [];
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'shield', name: 'Shield', kind: 'powerup' },
          { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
          { id: 'extra_life', name: 'Extra Life', kind: 'powerup' },
        ],
        autoSelectMs: 40,
        autoSelectIndex: 2,
        onSelect: (index: number) => calls.push(index),
      });
      await advanceGame(booted!.game, 250);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      scene.update(0, HOLD_FULL_COUNTDOWN_DURATION_MS);
      expect(calls).toEqual([2]);
    });

    it('AC5 — waits for a real selection when no delay is supplied', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      const calls: number[] = [];
      booted.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
        onSelect: (index: number) => calls.push(index),
      });
      await advanceGame(booted!.game, 250);

      expect(calls).toEqual([]);
      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      // Still open and awaiting input.
      expect(scene.getOptions()).toHaveLength(1);
    });

    it('a manual selection before the delay cancels the auto-select', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      const calls: number[] = [];
      booted.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
          { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        ],
        autoSelectMs: 200,
        onSelect: (index: number) => calls.push(index),
      });
      await advanceGame(booted!.game, 40);

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      scene.select(1);
      // The manual selection starts the countdown; complete it, then ensure
      // the cancelled auto-select timer does not fire a second selection.
      scene.update(0, HOLD_FULL_COUNTDOWN_DURATION_MS);
      await advanceGame(booted!.game, 300);

      // The late timer must not fire a second selection.
      expect(calls).toEqual([1]);
    });
  });

  describe('hold-full metronome (AH-0MV55O9R5005W6J0)', () => {
    it('AC1/AC2 — a fire schedule plays reduced-volume ghost fire on the beat grid, active weapons only', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      // Stop the live loop: drive the game with fixed-delta steps so the
      // metronome advances by a known, deterministic amount.
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
        fireSchedule: {
          anchorMs: 0,
          bpm: 80,
          startMs: 0,
          weapons: [
            { weaponId: 'cannon', intervalMs: 375 },
            { weaponId: 'rapid', intervalMs: 125 },
          ],
        },
      });
      // ~500 ms of deterministic ~60 fps frames: cannon's first ghost tick
      // is at 375 ms; rapid ticks every 125 ms.
      let time = 0;
      const dt = 1000 / 60;
      for (let i = 0; i < 30; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }

      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene).toBeTruthy();

      const cannon = recording.plays.filter(
        (p) => p.volume === HOLD_FULL_FIRE_VOLUME_SCALE && p.url.includes('aihell-cannon-fire'),
      );
      const rapid = recording.plays.filter(
        (p) => p.volume === HOLD_FULL_FIRE_VOLUME_SCALE && p.url.includes('aihell-rapid-fire'),
      );
      // Reduced volume on every ghost tick (AC1).
      expect(cannon.length).toBeGreaterThanOrEqual(1);
      // Rapid (125 ms) ticks twice before cannon's first 375 ms tick.
      expect(rapid.length).toBeGreaterThanOrEqual(2);
      // Every play is a reduced-volume player-weapon fire cue (AC2 — no
      // enemy or other gameplay cue).
      expect(recording.plays.length).toBeGreaterThan(0);
      for (const play of recording.plays) {
        expect(play.volume).toBe(HOLD_FULL_FIRE_VOLUME_SCALE);
        expect(play.url).toMatch(/aihell-(cannon|rapid|spread|dual|nova|mortar|arc)-fire\./);
      }
    });

    it('AC2 — omitting a fire schedule keeps the overlay silent (no ghost fire)', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
      });
      let time = 0;
      const dt = 1000 / 60;
      for (let i = 0; i < 30; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      expect(recording.plays).toHaveLength(0);
    });

    it('a selection keeps the metronome running under the countdown, then it ends when the overlay closes', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
        fireSchedule: {
          anchorMs: 0,
          bpm: 80,
          startMs: 0,
          weapons: [{ weaponId: 'cannon', intervalMs: 375 }],
        },
      });
      let time = 0;
      const dt = 1000 / 60;
      // A beat of ghost fire.
      for (let i = 0; i < 25; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      expect(recording.plays.length).toBeGreaterThan(0);

      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      const before = recording.plays.length;
      scene.select(0);
      // The reduced-volume fire continues underneath the 3-2-1 countdown
      // (producer decision) until the countdown completes and the overlay
      // closes.
      for (let i = 0; i < Math.ceil(HOLD_FULL_COUNTDOWN_DURATION_MS / dt) + 2; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      expect(recording.plays.length).toBeGreaterThan(before);
      // The overlay closed after the countdown (scene no longer active).
      expect(booted!.game.scene.isActive('MineralChoiceScene')).toBe(false);
      // No further ghost fire once the overlay (and its metronome) is gone.
      const after = recording.plays.length;
      for (let i = 0; i < 25; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      expect(recording.plays.length).toBe(after);
    });
  });

  describe('beat-locked 3-2-1 countdown (AH-0MV55OAQT004NMSN)', () => {
    it('selecting starts a 3-2-1 countdown and defers onSelect until it completes', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      const calls: Array<{ index: number; option: ChoiceOption }> = [];
      booted!.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
          { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        ],
        onSelect: (index: number, option: ChoiceOption) => {
          calls.push({ index, option });
        },
      });
      let time = 0;
      const dt = 1000 / 60;
      const stepInto = (n: number) => {
        for (let i = 0; i < n; i += 1) {
          time += dt;
          booted!.game.step(time, dt);
        }
      };
      stepInto(2);

      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      scene.select(1); // "Spread Shot", index 1

      // Immediately after selecting, the countdown begins ("3" shown) and
      // onSelect has NOT fired yet.
      expect(scene.getCountdownText()).toBe('3');
      expect(calls).toHaveLength(0);
      expect(scene.isCountdownActive()).toBe(true);

      // One beat later (750 ms at 80 BPM): "2".
      stepInto(Math.ceil(750 / dt));
      expect(scene.getCountdownText()).toBe('2');
      expect(calls).toHaveLength(0);

      // Two beats: "1".
      stepInto(Math.ceil(750 / dt));
      expect(scene.getCountdownText()).toBe('1');
      expect(calls).toHaveLength(0);

      // The beat after "1" (three beats total): the choice is applied and
      // the overlay closes.
      stepInto(Math.ceil(750 / dt) + 2);
      expect(calls).toEqual([
        { index: 1, option: scene.getOptions()[1] },
      ]);
      expect(scene.isCountdownActive()).toBe(false);
      expect(booted!.game.scene.isActive('MineralChoiceScene')).toBe(false);
    });

    it('plays the countdown tick cue once per count (recording provider)', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
      });
      let time = 0;
      const dt = 1000 / 60;
      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      // Boot + start the countdown with a live selection.
      for (let i = 0; i < 3; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      scene.select(0);
      const countdownTicks = () =>
        recording.plays.filter((p) => p.url.includes('aihell-countdown-tick'));
      // The first count's tick plays immediately on selection.
      expect(countdownTicks()).toHaveLength(1);
      // Advance through the two remaining counts.
      for (let i = 0; i < Math.ceil(HOLD_FULL_COUNTDOWN_DURATION_MS / dt); i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      // One distinct cue per count: 3 total.
      expect(countdownTicks()).toHaveLength(3);
    });

    it('rises the tick tone with each beat (recording provider) (AH-0MV722WJS0075UTZ)', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }],
      });
      let time = 0;
      const dt = 1000 / 60;
      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      for (let i = 0; i < 3; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      scene.select(0);
      // Two more beats of countdown (count 2 then count 1).
      for (let i = 0; i < Math.ceil(HOLD_FULL_COUNTDOWN_DURATION_MS / dt); i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      const rates = recording.plays
        .filter((p) => p.url.includes('aihell-countdown-tick'))
        .map((p) => p.rate);
      // Count 3 base (1.0), count 2 and count 1 strictly rising.
      expect(rates).toHaveLength(3);
      expect(rates[0]).toBe(1);
      expect(rates[1]).toBeGreaterThan(rates[0]);
      expect(rates[2]).toBeGreaterThan(rates[1]);
    });

    it('removes the choice screen the moment the countdown starts (AH-0MV722WJS0075UTZ)', async () => {
      booted = await bootScene([HarnessScene, MineralChoiceScene]);
      booted!.game.loop.stop();
      booted!.game.scene.start('MineralChoiceScene', {
        options: [
          { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
          { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
          { id: 'magnet', name: 'Magnet', kind: 'powerup' },
        ],
      });
      let time = 0;
      const dt = 1000 / 60;
      const scene = booted!.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      for (let i = 0; i < 3; i += 1) {
        time += dt;
        booted!.game.step(time, dt);
      }
      // Before selection the choice screen is visible.
      expect(scene.isChoiceScreenVisible()).toBe(true);
      expect(scene.getOptionLabels()).toHaveLength(3);

      scene.select(1);

      // Selecting tears the choice UI down immediately: no options remain,
      // only the countdown numeral is on screen.
      expect(scene.isChoiceScreenVisible()).toBe(false);
      expect(scene.getOptionLabels()).toHaveLength(0);
      expect(scene.isCountdownActive()).toBe(true);
      expect(scene.getCountdownText()).toBe('3');
    });
  });
});
