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
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../../core/rules';
import { HOLD_FULL_COUNTDOWN_DURATION_MS } from '../core/holdFullCountdown';
import { bootScene, BootedGame } from '../../test/gameHarness';
import { RecordingSfxProvider } from '../../test/audioTestDouble';
import type { ChoiceOption } from '../../powerups/choice';
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    const scene = booted.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(scene.getOptions().map((o) => o.id)).toEqual(['speed_boost', 'spread']);
    expect(scene.getOptionLabels()).toHaveLength(2);
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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDetailLines()[0]).toBe('\u2605 New');
    });
  });

  describe('option descriptions (AH-0MV2N2591007UGPD)', () => {
    it('AC2 — renders a description line as part of a three-line block', async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

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
      await new Promise((resolve) => setTimeout(resolve, 50));

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      expect(scene.getDescriptionLines()).toEqual([]);
      expect(scene.getDetailLines()).toEqual([]);
      expect(scene.getOptionLabels()).toHaveLength(1);
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
      await new Promise((resolve) => setTimeout(resolve, 250));

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
      await new Promise((resolve) => setTimeout(resolve, 250));

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
      await new Promise((resolve) => setTimeout(resolve, 250));

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
      await new Promise((resolve) => setTimeout(resolve, 40));

      const scene = booted.game.scene.getScene(
        'MineralChoiceScene',
      ) as MineralChoiceScene;
      scene.select(1);
      // The manual selection starts the countdown; complete it, then ensure
      // the cancelled auto-select timer does not fire a second selection.
      scene.update(0, HOLD_FULL_COUNTDOWN_DURATION_MS);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The late timer must not fire a second selection.
      expect(calls).toEqual([1]);
    });
  });

  describe('hold-full metronome (AH-0MV55O9R5005W6J0)', () => {
    it('AC1/AC2 — a fire schedule plays reduced-volume ghost fire on the beat grid, active weapons only', async () => {
      const recording = new RecordingSfxProvider();
      effects.setSfxSoundProvider(recording);
      booted = await bootScene([HarnessScene, MineralChoiceScene], {
        deterministicBoot: true,
      });
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
      booted = await bootScene([HarnessScene, MineralChoiceScene], {
        deterministicBoot: true,
      });
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
      booted = await bootScene([HarnessScene, MineralChoiceScene], {
        deterministicBoot: true,
      });
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
      booted = await bootScene([HarnessScene, MineralChoiceScene], {
        deterministicBoot: true,
      });
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
      booted = await bootScene([HarnessScene, MineralChoiceScene], {
        deterministicBoot: true,
      });
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
  });
});
