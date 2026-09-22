/**
 * Hold-full power-up choice scene (GDD §4.5, AH-0MUBVGI62004ED9Q).
 *
 * A modal overlay shown when the ship's mineral hold fills. `PlayScene`
 * pauses itself at the SceneManager level and launches this scene, so
 * gameplay state is preserved exactly (mirroring `PauseScene`). It presents
 * the distinct options supplied by the pluggable choice strategy as
 * pointer- and keyboard-operable controls; selecting one hands the index
 * back to `PlayScene` (which applies the effect permanently for the run,
 * resumes play, and resets the hold with any overflow) and closes the
 * overlay.
 *
 * The strategy is pluggable (see `powerups/choice`): the scene only renders
 * and forwards the selection, so swapping the policy needs no scene change.
 *
 * @module src/scenes/MineralChoiceScene
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { randomChoiceStrategy, type ChoiceOption, type ChoiceStrategy } from '../powerups/choice';
import type { PlayScene } from './PlayScene';

/** Neon-gold heading colour (matches the mineral palette). */
const CHOICE_HEADING_COLOR = '#ffdd44';
/** Neon-cyan option colour. */
const CHOICE_OPTION_COLOR = '#00ffff';
/** Translucent backdrop so the paused field remains visible behind. */
const CHOICE_BACKDROP_ALPHA = 0.75;

export class MineralChoiceScene extends Phaser.Scene {
  private options: ChoiceOption[] = [];
  private controls: Phaser.GameObjects.Text[] = [];
  /** Optional generic selection handler (used by the gyms). */
  private onSelect: ((index: number, option: ChoiceOption) => void) | null = null;

  constructor() {
    super('MineralChoiceScene');
  }

  /**
   * @param data.options — the options to present (defaults to the strategy's
   *   three picks).
   * @param data.strategy — pluggable strategy used when `options` is absent.
   * @param data.onSelect — generic selection handler; when omitted the
   *   overlay forwards to the registered `PlayScene`.
   */
  init(
    data: {
      options?: ChoiceOption[];
      strategy?: ChoiceStrategy;
      onSelect?: (index: number, option: ChoiceOption) => void;
    } = {},
  ): void {
    const strategy = data.strategy ?? randomChoiceStrategy;
    this.options = data.options ?? strategy.choose(3);
    this.onSelect = data.onSelect ?? null;
  }

  create(): void {
    this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, CHOICE_BACKDROP_ALPHA)
      .setOrigin(0);

    this.add
      .text(GAME_WIDTH / 2, 120, 'HOLD FULL — CHOOSE A POWER-UP', {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: CHOICE_HEADING_COLOR,
      })
      .setOrigin(0.5);

    this.controls = [];
    this.options.forEach((option, index) => {
      const text = this.add
        .text(GAME_WIDTH / 2, 210 + index * 64, `${index + 1}.  ${option.name}`, {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: CHOICE_OPTION_COLOR,
          backgroundColor: '#111111',
          padding: { x: 16, y: 8 },
        })
        .setOrigin(0.5);
      text.setInteractive({ useHandCursor: true });
      text.on('pointerdown', () => this.select(index));
      this.controls.push(text);
    });

    // Number keys 1..n select the matching option.
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const n = Number.parseInt(event.key, 10);
      if (n >= 1 && n <= this.options.length) this.select(n - 1);
    });
  }

  /** The options currently presented (copy). */
  getOptions(): ChoiceOption[] {
    return [...this.options];
  }

  /** The rendered option labels (e.g. `["1.  Shield", ...]`). */
  getOptionLabels(): string[] {
    return this.controls.map((control) => control.text);
  }

  /**
   * Selects option `index`: forwards the choice to `PlayScene` (which
   * applies it, resumes and resets the hold), then resumes play and closes
   * this overlay. Returns the chosen option, or null for an out-of-range
   * index.
   */
  select(index: number): ChoiceOption | null {
    const option = this.options[index];
    if (!option) return null;

    if (this.onSelect) {
      this.onSelect(index, option);
    } else {
      const play = this.scene.manager.getScene('PlayScene') as PlayScene | null;
      if (play) {
        play.selectMineralChoice(index);
        this.scene.resume('PlayScene');
      }
    }
    this.scene.stop();
    return option;
  }
}
