/**
 * Hold-full power-up choice scene (GDD §4.5, AH-0MUBVGI62004ED9Q).
 *
 * A modal overlay shown when the ship's mineral hold fills. The owning
 * scene pauses itself at the SceneManager level and launches this scene, so
 * gameplay state is preserved exactly (mirroring `PauseScene`). It presents
 * the distinct options supplied by the launcher as pointer- and
 * keyboard-operable controls; selecting one hands the index back through the
 * single optional `onSelect` callback (the launcher applies the effect
 * permanently for the run, resumes play, and resets the hold with any
 * overflow) and closes the overlay.
 *
 * Each option renders as a three-line block: the option name, a one-line
 * description of what the item does (from `ChoiceOption.description`, resolved
 * from the shared catalogues) and then the existing change summary / `★ New`
 * line, so an unfamiliar offer is self-explanatory (AH-0MV2N2591007UGPD).
 *
 * The overlay deliberately knows nothing about its launcher (`PlayScene`,
 * `GymFormationScene`, …): the only selection contract is the `onSelect`
 * callback, so the game and every gym drive it identically.
 *
 * The strategy is pluggable (see `powerups/choice`): when a launcher omits
 * `options`, the scene draws its own defaults from the strategy, so swapping
 * the policy needs no scene change.
 *
 * @module src/scenes/MineralChoiceScene
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../core/rules';
import { randomChoiceStrategy, type ChoiceOption, type ChoiceStrategy } from '../powerups/choice';
import {
  createHoldFullFireMetronome,
  type HoldFullFireMetronome,
  type HoldFullFireSchedule,
} from './core/holdFullFire';
import { playWeaponFireSound } from '../audio/effects';

/** Neon-gold heading colour (matches the mineral palette). */
const CHOICE_HEADING_COLOR = '#ffdd44';
/** Neon-cyan option colour. */
const CHOICE_OPTION_COLOR = '#00ffff';
/** Secondary / muted colour for change summaries. */
const CHOICE_DETAIL_COLOR = '#aaaaaa';
/** Muted colour for the one-line item description. */
const CHOICE_DESCRIPTION_COLOR = '#cccccc';
/** Accent colour for the "New" badge. */
const CHOICE_NEW_COLOR = '#ff8800';
/** Fully opaque backdrop, blanking the screen behind the choice dialog. */
const CHOICE_BACKDROP_ALPHA = 1.0;
/** Vertical centre (px) of the first option row. */
const CHOICE_FIRST_ROW_Y = 200;
/**
 * Vertical pitch (px) between option rows. Widened from the two-line 64 px so
 * the three-line block (name → description → detail) never collides with the
 * next option (AH-0MV2N2591007UGPD · AC2).
 */
const CHOICE_ROW_PITCH = 84;
/** Y offset (px) of the description line beneath an option name. */
const CHOICE_DESCRIPTION_OFFSET = 28;
/** Y offset (px) of the change-summary / `★ New` line beneath the description. */
const CHOICE_DETAIL_OFFSET = 48;

export class MineralChoiceScene extends Phaser.Scene {
  private options: ChoiceOption[] = [];
  private controls: Phaser.GameObjects.Text[] = [];
  /** Detail-line text objects (one per option). */
  private details: Phaser.GameObjects.Text[] = [];
  /** Description-line text objects (one per option that carries a description). */
  private descriptions: Phaser.GameObjects.Text[] = [];
  /** Optional generic selection handler supplied by the launcher. */
  private onSelect: ((index: number, option: ChoiceOption) => void) | null = null;
  /**
   * Demo-only auto-select delay (ms); 0 disables auto-select so the overlay
   * waits for a real pointer/keyboard selection (AH-0MUXXQ1MN002RXGB).
   */
  private autoSelectMs = 0;
  /** Pending demo auto-select timer (null when disabled or already fired). */
  private autoSelectTimer: Phaser.Time.TimerEvent | null = null;
  /** Demo-only option index the auto-select picks (default 0, the first). */
  private autoSelectIndex = 0;
  /**
   * Frozen player-fire schedule passed by the launcher: drives the
   * reduced-volume metronomic ghost fire while the overlay is open
   * (AH-0MV55O9R5005W6J0). Null when the launcher supplies none (isolated
   * tests) — then the overlay is silent as before.
   */
  private fireSchedule: HoldFullFireSchedule | null = null;
  /** Live metronome emitting the reduced-volume ghost ticks. */
  private metronome: HoldFullFireMetronome | null = null;

  constructor() {
    super('MineralChoiceScene');
  }

  /**
   * @param data.options — the options to present (defaults to the strategy's
   *   three picks).
   * @param data.strategy — pluggable strategy used when `options` is absent.
   * @param data.onSelect — the single selection contract every launcher
   *   supplies: receives the chosen index and option. When omitted the
   *   overlay simply closes (used by isolated tests).
   * @param data.autoSelectMs — when > 0 the overlay auto-selects an option
   *   after this delay (the shipped attract/demo mode). Normal play omits it
   *   and waits for a real selection.
   * @param data.autoSelectIndex — the option index the demo auto-select
   *   picks (default `0`, the first option). The demo launcher passes the
   *   preferred option (e.g. the offered Extra Life below the life cap);
   *   normal play never sets it (AH-0MV03GXZQ00801T4 · AC1).
   * @param data.fireSchedule — the frozen player-fire schedule captured at
   *   launch; when present the overlay plays each active weapon's fire cue
   *   on the beat grid at {@link HOLD_FULL_FIRE_VOLUME_SCALE} until a
   *   selection closes it (AH-0MV55O9R5005W6J0 · AC1/AC2).
   */
  init(
    data: {
      options?: ChoiceOption[];
      strategy?: ChoiceStrategy;
      onSelect?: (index: number, option: ChoiceOption) => void;
      autoSelectMs?: number;
      autoSelectIndex?: number;
      fireSchedule?: HoldFullFireSchedule;
    } = {},
  ): void {
    const strategy = data.strategy ?? randomChoiceStrategy;
    this.options = data.options ?? strategy.choose(3);
    this.onSelect = data.onSelect ?? null;
    this.autoSelectMs = data.autoSelectMs ?? 0;
    this.autoSelectIndex = data.autoSelectIndex ?? 0;
    this.fireSchedule = data.fireSchedule ?? null;
  }

  create(): void {
    // Bring this scene above PlayScene in the z-order so the opaque backdrop
    // covers the entire screen (GDD §4.5, AH-0MUDYSIRY0036EDC).
    this.scene.bringToTop();

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
    this.details = [];
    this.descriptions = [];
    this.options.forEach((option, index) => {
      const y = CHOICE_FIRST_ROW_Y + index * CHOICE_ROW_PITCH;

      // Primary label: "1.  Spread Shot Lv.3"
      const label = this.add
        .text(GAME_WIDTH / 2, y, `${index + 1}.  ${option.name}`, {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: CHOICE_OPTION_COLOR,
          backgroundColor: '#111111',
          padding: { x: 16, y: 8 },
        })
        .setOrigin(0.5);
      label.setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => this.select(index));
      this.controls.push(label);

      // Description line: what the item actually does, resolved from the
      // shared catalogue. Rendered as its own line beneath the name so a new
      // or unfamiliar offer is self-explanatory (AH-0MV2N2591007UGPD · AC2).
      // Omitted entirely when an option carries no description — never an
      // empty text object.
      const description = option.description?.trim();
      if (description) {
        const descriptionLine = this.add
          .text(GAME_WIDTH / 2, y + CHOICE_DESCRIPTION_OFFSET, description, {
            fontFamily: 'monospace',
            fontSize: '13px',
            color: CHOICE_DESCRIPTION_COLOR,
          })
          .setOrigin(0.5);
        this.descriptions.push(descriptionLine);
      }

      // Detail line: change summary or "New" badge, beneath the description.
      const detailY = y + CHOICE_DETAIL_OFFSET;
      let detailText = '';
      if (option.isNew) {
        detailText = '★ New';
      } else if (option.changeSummary) {
        detailText = option.changeSummary;
      }
      if (detailText) {
        const detail = this.add
          .text(GAME_WIDTH / 2, detailY, detailText, {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: option.isNew ? CHOICE_NEW_COLOR : CHOICE_DETAIL_COLOR,
          })
          .setOrigin(0.5);
        this.details.push(detail);
      }
    });

    // Number keys 1..n select the matching option.
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const n = Number.parseInt(event.key, 10);
      if (n >= 1 && n <= this.options.length) this.select(n - 1);
    });

    // Demo/attract mode: pick an option automatically after a human-like
    // delay so the run never stalls on the overlay
    // (AH-0MUXXQ1MN002RXGB · AC4). Normal play leaves `autoSelectMs` at 0 and
    // waits for a real selection (AC5). The demo launcher may nominate a
    // preferred index (e.g. an offered Extra Life); default 0 keeps the
    // previous first-option behaviour (AH-0MV03GXZQ00801T4 · AC1).
    if (this.autoSelectMs > 0) {
      this.autoSelectTimer = this.time.delayedCall(this.autoSelectMs, () =>
        this.select(this.autoSelectIndex),
      );
    }
    // Start the reduced-volume metronomic ghost fire from the frozen
    // player-fire schedule (AC1/AC2). The overlay scene keeps running while
    // the launcher is paused, so its own update loop drives the metronome.
    this.metronome = this.fireSchedule
      ? createHoldFullFireMetronome(this.fireSchedule)
      : null;
  }

  /**
   * Drives the hold-full metronome with this scene's elapsed time: every
   * frame advances the ghost-fire scheduler and plays a reduced-volume fire
   * cue for each active weapon whose beat tick was reached. Pure timing — no
   * projectiles, no gameplay simulation (AH-0MV55O9R5005W6J0 · AC1).
   */
  override update(_time: number, delta: number): void {
    const metronome = this.metronome;
    if (metronome === null) return;
    for (const weaponId of metronome.advance(delta)) {
      playWeaponFireSound(weaponId, {
        volume: HOLD_FULL_FIRE_VOLUME_SCALE,
      });
    }
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
   * The rendered detail lines beneath each option (e.g.
   * `["+1 Projectiles", "★ New", ...]`).  Returns an empty array when no
   * detail lines are present. The change-summary / `★ New` contract is
   * unchanged; the description is a separate line (see
   * {@link getDescriptionLines}).
   */
  getDetailLines(): string[] {
    return this.details.map((d) => d.text);
  }

  /**
   * The rendered description lines beneath each option name (e.g.
   * `["Adds a 3-bullet fan (−30°/0°/+30°).", ...]`). One entry per option
   * that carries a non-empty `description`; empty when none do. Exposed so
   * tests can assert the overlay shows the shared catalogue copy
   * (AH-0MV2N2591007UGPD · AC2/AC6).
   */
  getDescriptionLines(): string[] {
    return this.descriptions.map((d) => d.text);
  }

  /**
   * Selects option `index`: forwards the choice to the launcher through the
   * `onSelect` callback (which applies it, resumes and resets the hold) and
   * closes this overlay. Returns the chosen option, or null for an
   * out-of-range index.
   */
  select(index: number): ChoiceOption | null {
    const option = this.options[index];
    if (!option) return null;

    // Cancel any pending demo auto-select so it cannot fire twice.
    this.autoSelectTimer?.remove(false);
    this.autoSelectTimer = null;
    // Stop the metronomic ghost fire — the selection (and the launcher's
    // resume) hands back to live fire (AH-0MV55O9R5005W6J0).
    this.metronome = null;
    const handler = this.onSelect;
    this.onSelect = null;
    handler?.(index, option);
    this.scene.stop();
    return option;
  }
}
