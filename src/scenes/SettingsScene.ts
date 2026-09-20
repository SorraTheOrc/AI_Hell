/**
 * Settings screen — audio section (GDD §6.6 `ai_hell_settings`, parent
 * AH-0MU9LPZ0G0015292).
 *
 * A clearly labelled 0.0–1.0 SFX volume slider plus an SFX mute toggle.
 * Changes apply **live** to every SFX through the master-volume plumbing
 * in `effects.ts` and persist to `ai_hell_settings` via the settings
 * store, so the next load or screen entry restores them. The persisted
 * volume level is preserved while muted, so un-muting restores it.
 *
 * Keyboard navigation is scene-local (same pattern as PauseScene): the
 * shared `FocusManager` is deferred to AH-0MU9LKQEP008LCX9. Up/down cycle
 * the controls, left/right adjust the slider when it is focused,
 * Enter/Space activate, ESC goes Back.
 *
 * Entry points: PauseScene → origin 'PauseScene' (Back returns to the
 * pause menu); MenuScene → origin 'MenuScene' (Back returns to the menu,
 * wired by the MenuScene Settings-button child).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from '../core/settingsStore';
import { setSfxMuted, setSfxVolume } from '../audio/effects';

/** Neon-cyan colour for the section heading (GDD §7.1). */
const SETTINGS_TEXT_COLOR = '#00ffff';
/** Colour of the focused control. */
const SETTINGS_FOCUS_COLOR = '#ffffff';
/** Colour of unfocused controls. */
const SETTINGS_DIM_COLOR = '#8899aa';
/** Slider track width (px). */
const SLIDER_WIDTH = 240;
/** Slider track height (px). */
const SLIDER_HEIGHT = 8;
/** Keyboard step for the slider (0.05 ≈ 5%). */
const SLIDER_KEY_STEP = 0.05;

/** Scene-data shape passed by the caller (`{ origin }`). */
interface SettingsSceneData {
  origin?: string;
}

/** A focusable control with optional per-key and activation handlers. */
interface SettingsControl {
  label: string;
  onLeft?: () => void;
  onRight?: () => void;
  activate?: () => void;
}

export class SettingsScene extends Phaser.Scene {
  private origin = 'PauseScene';

  private sfxVolume = DEFAULT_SETTINGS.sfxVolume;
  private sfxMuted = DEFAULT_SETTINGS.sfxMuted;

  private controls: SettingsControl[] = [];
  private focusedIndex = 0;

  private sliderTrack!: Phaser.GameObjects.Rectangle;
  private sliderHandle!: Phaser.GameObjects.Rectangle;
  private volumeText!: Phaser.GameObjects.Text;
  private muteText!: Phaser.GameObjects.Text;
  private backText!: Phaser.GameObjects.Text;
  private dragging = false;

  constructor() {
    super('SettingsScene');
  }

  create(data?: SettingsSceneData): void {
    this.origin = data?.origin ?? 'PauseScene';

    // Restore persisted values (defaults when unset) and apply them live.
    const settings = loadSettings();
    this.sfxVolume = settings.sfxVolume;
    this.sfxMuted = settings.sfxMuted;
    setSfxVolume(this.sfxVolume);
    setSfxMuted(this.sfxMuted);

    // Full-screen background.
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);
    this.add
      .text(GAME_WIDTH / 2, 90, 'SETTINGS', {
        fontFamily: 'monospace',
        fontSize: '36px',
        color: SETTINGS_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this._buildVolumeSection();
    this._buildMuteToggle();
    this._buildBack();

    this.controls = [
      { label: 'volume', onLeft: () => this._nudgeVolume(-SLIDER_KEY_STEP), onRight: () => this._nudgeVolume(SLIDER_KEY_STEP) },
      { label: 'mute', activate: () => this._toggleMute() },
      { label: 'back', activate: () => this.goBack() },
    ];
    this._drawSlider();
    this._drawMute();
    this._setFocus(0);

    this._bindKeyboard();
  }

  // ── UI construction ─────────────────────────────────────────────

  private _buildVolumeSection(): void {
    this.add
      .text(GAME_WIDTH / 2, 190, 'SFX Volume', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: SETTINGS_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.volumeText = this.add
      .text(0, 0, '0.00', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: SETTINGS_FOCUS_COLOR,
      })
      .setOrigin(0.5);

    const trackX = GAME_WIDTH / 2;
    const trackY = 240;
    this.sliderTrack = this.add.rectangle(
      trackX,
      trackY,
      SLIDER_WIDTH,
      SLIDER_HEIGHT,
      0x223344,
    );
    this.sliderTrack.setInteractive({ useHandCursor: true });
    this.sliderTrack.on('pointerdown', (pointer: { x: number }) => {
      this.dragging = true;
      this._sliderFromPointer(pointer.x);
    });
    this.sliderTrack.on('pointermove', (pointer: { x: number }) => {
      if (this.dragging) this._sliderFromPointer(pointer.x);
    });
    this.input.on('pointerup', () => {
      this.dragging = false;
    });

    // Handle sits on the track and follows the current value.
    this.sliderHandle = this.add.rectangle(trackX, trackY, 10, 22, 0x00ffff);
  }

  private _buildMuteToggle(): void {
    this.muteText = this.add
      .text(GAME_WIDTH / 2, 310, '', {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: SETTINGS_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    this.muteText.setInteractive({ useHandCursor: true });
    this.muteText.on('pointerdown', () => this._toggleMute());
  }

  private _buildBack(): void {
    const back = this.add
      .text(GAME_WIDTH / 2, 420, '←  Back', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: SETTINGS_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    back.setInteractive({ useHandCursor: true });
    back.on('pointerdown', () => this.goBack());
    this.backText = back;
  }

  // ── Value rendering ─────────────────────────────────────────────

  /** Positions the handle, the % text and its mute label. */
  private _drawSlider(): void {
    const left = GAME_WIDTH / 2 - SLIDER_WIDTH / 2;
    this.sliderHandle.x = left + this.sfxVolume * SLIDER_WIDTH;
    this.volumeText.text = this.sfxVolume.toFixed(2);
    this.volumeText.setPosition(GAME_WIDTH / 2, 270);
  }

  private _drawMute(): void {
    this.muteText.text = this.sfxMuted ? 'SFX: MUTED' : 'SFX: ON';
  }

  // ── Actions ─────────────────────────────────────────────────────

  /** Current SFX volume (0–1). */
  getSfxVolume(): number {
    return this.sfxVolume;
  }

  /** Whether SFX is muted. */
  isSfxMuted(): boolean {
    return this.sfxMuted;
  }

  /**
   * Sets the SFX volume (clamped to 0–1), applies it live to the master
   * SFX gain and persists it. Public so the slider (pointer/keyboard) and
   * tests share one code path.
   */
  setVolume(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.sfxVolume = Math.round(clamped * 100) / 100;
    this._drawSlider();
    setSfxVolume(this.sfxVolume);
    this._persist();
  }

  /** Mutes (`true`) or un-mutes (`false`) SFX; volume level is preserved. */
  setMuted(muted: boolean): void {
    this.sfxMuted = muted;
    this._drawMute();
    setSfxMuted(this.sfxMuted);
    this._persist();
  }

  /** Persists the current audio settings without clobbering bindings. */
  private _persist(): void {
    saveSettings({
      sfxVolume: this.sfxVolume,
      sfxMuted: this.sfxMuted,
      bindings: loadSettings().bindings,
    });
  }

  private _nudgeVolume(delta: number): void {
    this.setVolume(this.sfxVolume + delta);
  }

  private _toggleMute(): void {
    this.setMuted(!this.sfxMuted);
  }

  /** Converts a pointer x position on the track into a volume value. */
  private _sliderFromPointer(x: number): void {
    const left = GAME_WIDTH / 2 - SLIDER_WIDTH / 2;
    this.setVolume((x - left) / SLIDER_WIDTH);
  }

  /** Returns to the scene that opened the settings screen. */
  goBack(): void {
    this.scene.start(this.origin);
  }

  // ── Focus + keyboard ────────────────────────────────────────────

  private _setFocus(index: number): void {
    const count = this.controls.length;
    if (count === 0) return;
    this.focusedIndex = ((index % count) + count) % count;
    const focused = this.controls[this.focusedIndex].label;
    const sliderFocused = focused === 'volume';
    // Keep the value text permanently white; highlight the active control.
    this.volumeText.setStyle({ color: sliderFocused ? SETTINGS_FOCUS_COLOR : SETTINGS_DIM_COLOR });
    this.muteText.setStyle({ color: focused === 'mute' ? SETTINGS_FOCUS_COLOR : SETTINGS_DIM_COLOR });
    this.backText.setStyle({ color: focused === 'back' ? SETTINGS_FOCUS_COLOR : SETTINGS_DIM_COLOR });
  }

  private _moveFocus(delta: number): void {
    this._setFocus(this.focusedIndex + delta);
  }

  private _activateFocused(): void {
    this.controls[this.focusedIndex]?.activate?.();
  }

  private _bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.repeat) return;
      switch (event.key) {
        case 'Escape':
          this.goBack();
          break;
        case 'Tab':
        case 'ArrowDown':
          event.preventDefault?.();
          this._moveFocus(1);
          break;
        case 'ArrowUp':
          event.preventDefault?.();
          this._moveFocus(-1);
          break;
        case 'ArrowRight':
          this.controls[this.focusedIndex]?.onRight?.();
          break;
        case 'ArrowLeft':
          this.controls[this.focusedIndex]?.onLeft?.();
          break;
        case 'Enter':
        case ' ':
          event.preventDefault?.();
          this._activateFocused();
          break;
        default:
          break;
      }
    });
  }

  // ── Test accessors ──────────────────────────────────────────────

  /** Focusable control labels in focus order. */
  getControlLabels(): string[] {
    return this.controls.map((c) => c.label);
  }

  /** Label of the currently focused control. */
  getFocusedLabel(): string {
    return this.controls[this.focusedIndex]?.label ?? '';
  }
}