/**
 * Gym scene — weapon tuning panel (AH-0MW0Q1HMH0037RNC, parent
 * AH-0MW0Q01VM004EPY7).
 *
 * A designer opens this gym to retune the catalogue values the epic exists
 * for — **bullet colour, bullet size/lifetime/shape, AOE radius/trigger,
 * orbit radius/pods and impact cues** — with a live preview fired on a dummy
 * target, then **Save** (upsert the current row) or **Save As** (duplicate
 * under a new id) to `src/data/weapons.csv`. It is the weapon-catalogue
 * counterpart to `GymBotTuning`.
 *
 * ## What it does
 *
 * - Lists all 16 catalogue weapons (`WEAPON_IDS`) in a native `<select>` and
 *   shows the resolved definition the game would fire.
 * - Binds one native control per editable field (sliders, colour inputs,
 *   selects, text) using the shared `.gym-panel` markup — no bespoke widget
 *   styles, and every control is keyboard-operable for free.
 * - Applies an unsaved draft to the live catalogue
 *   (`weaponCatalogueStore.previewWeaponDefinition`) on every input, so the
 *   preview ship fires the edited definition on its next shot. The ship and
 *   dummy target run the **shared** combat core (`_tickPlayer` auto-fire,
 *   shared AOE dispatch/VFX and impact feedback), so the preview cannot drift
 *   from the game.
 * - **Save** writes through the dev-only CSV plugin and then **re-reads** the
 *   file (`saveWeaponDefinition`), so the running catalogue is exactly the
 *   file just saved. **Save As** is refused unless a code fallback definition
 *   (icon + audio cue) exists for the new id — a bare CSV row cannot resolve
 *   either (AC3).
 * - Outside `npm run dev` there is no write endpoint: Save / Save As are
 *   disabled with a visible read-only message (AC4/AC8).
 *
 * ## Rhythm panel (AC7)
 *
 * Firing cadence is **not** editable here: the live rhythm is the Euclidean
 * ladder in `src/data/weapon-levels.json` (`resolveWeaponPattern`). The panel
 * renders the selected weapon's ladder rung by rung from
 * `WEAPON_EUCLIDEAN_LADDERS` (level range, `k`, `n`, rotation, onsets/beat,
 * derived interval), lets the designer audition a rung on the dummy target,
 * and states plainly that changing it is a hand-edit of the JSON file. The
 * legacy `subdivisions` figure from `weapons.csv` is shown **read-only** and
 * labelled as the legacy nominal value, so there is no control that would not
 * change cadence.
 *
 * ## Divergence
 *
 * The dummy target is the documented gym-only scenario (the game has no
 * static targets); all weapon behaviour, AOE dispatch, impact feedback and the
 * fire scheduler are the shipped shared code. Recorded in
 * `docs/GYM_PARITY.md` and §5.1 of
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`.
 *
 * @module src/scenes/gym/GymWeaponTuning
 */

import Phaser from 'phaser';

import {
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from '../core/CombatCoreScene';
import { CombatScene } from '../core/CombatScene';
import { gymBackgroundLevel } from './core/gymBackground';
import type { SceneSetupState } from '../core/sceneSetup';
import { Player } from '../../entities/Player';
import { PlayerBullet } from '../../entities/PlayerBullet';
import { advancePlayerBullets } from '../core/bulletLifecycle';
import { EffectsRegistry } from '../../powerups/effects';
import { playWeaponFireSound } from '../../audio/effects';
import {
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_IDS,
  isTimedWeapon,
  type AoETrigger,
  type BulletShape,
  type WeaponDefinition,
  type WeaponId,
} from '../../utils/weapons';
import {
  VALID_AOE_TRIGGERS,
  VALID_BULLET_SHAPES,
} from '../../core/csv';
import {
  WEAPON_EUCLIDEAN_LADDERS,
  WEAPON_EUCLIDEAN_LADDER_SPECS,
  euclideanOnsetIntervalMs,
  isStraightEuclidean,
  overrideWeaponLevelRungs,
  type WeaponLadderRung,
} from '../../utils/weaponLevels';
import {
  buildWeaponLevelsWriteBody,
  isWeaponLevelsWritable,
  saveWeaponLevels,
  validateWeaponLevelRungs,
} from '../../core/weaponLevelsStore';
import {
  getLiveWeaponDefinition,
  getPersistedWeaponDefinition,
  isWeaponCatalogueWritable,
  listWeaponIds,
  previewWeaponDefinition,
  restorePersistedWeaponDefinition,
  saveWeaponDefinition,
  saveWeaponDefinitionAs,
  cloneWeaponDefinition,
} from '../../core/weaponCatalogueStore';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import { makeCollapsible } from '../../utils/gymPanel';
import { attachTooltip } from '../../utils/gymTooltip';
import { colorToHex, hexToColor } from './GymPlayer';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';

/** Scene key — also the class name so the gym-index glob discovers it. */
export const GYM_WEAPON_TUNING_SCENE_KEY = 'GymWeaponTuning';

/** DOM id of the tuning panel. */
export const WEAPON_TUNING_PANEL_ID = 'gym-weapon-tuning-panel';
/** DOM id of the weapon selector. */
export const WEAPON_TUNING_SELECT_ID = 'gym-weapon-tuning-select';
/** DOM id of the live resolved-definition summary line. */
export const WEAPON_TUNING_SUMMARY_ID = 'gym-weapon-tuning-summary';
/** DOM id of the read-only notice (non-dev builds only). */
export const WEAPON_TUNING_READONLY_ID = 'gym-weapon-tuning-readonly';
/** DOM id of the rhythm panel body. */
export const WEAPON_TUNING_RHYTHM_ID = 'gym-weapon-tuning-rhythm';
/** DOM id of the editable rhythm rung controls container. */
export const WEAPON_TUNING_RHYTHM_EDITORS_ID =
  'gym-weapon-tuning-rhythm-editors';
/** DOM id of the rhythm-draft diagnostic line. */
export const WEAPON_TUNING_RHYTHM_STATUS_ID =
  'gym-weapon-tuning-rhythm-status';
/** Data attribute (value = rung index) marking an editable rhythm row. */
export const WEAPON_TUNING_RHYTHM_ROW_ATTR = 'data-weapon-rhythm-row';
/** Data attribute (value = k|n|rotation) identifying a rhythm control. */
export const WEAPON_TUNING_RHYTHM_FIELD_ATTR = 'data-weapon-rhythm-field';
/** DOM id of the read-only legacy-nominal subdivison line. */
export const WEAPON_TUNING_NOMINAL_ID = 'gym-weapon-tuning-nominal';
/** DOM id of the rhythm preview-level slider. */
export const WEAPON_TUNING_PREVIEW_LEVEL_ID = 'gym-weapon-tuning-preview-level';
/** DOM id of the Save button. */
export const WEAPON_TUNING_SAVE_ID = 'gym-weapon-tuning-save';
/** DOM id of the Save As id input. */
export const WEAPON_TUNING_SAVE_AS_INPUT_ID = 'gym-weapon-tuning-save-as-input';
/** DOM id of the Save As button. */
export const WEAPON_TUNING_SAVE_AS_ID = 'gym-weapon-tuning-save-as';
/** DOM id of the status readout. */
export const WEAPON_TUNING_STATUS_ID = 'gym-weapon-tuning-status';
/** Data attribute (value = field key) identifying an editable control. */
export const WEAPON_TUNING_FIELD_ATTR = 'data-weapon-field';
/** Data attribute (value = field key) identifying a control's readout. */
export const WEAPON_TUNING_VALUE_ATTR = 'data-weapon-field-value';
/** Data attribute marking a control row (hidden when inapplicable). */
export const WEAPON_TUNING_ROW_ATTR = 'data-weapon-row';

/** Vertical offset (px) of the dummy target above the preview ship. */
export const WEAPON_TUNING_TARGET_OFFSET = 56;

/** Hint line shown at the top of the gym. */
export const WEAPON_TUNING_HINT =
  'Weapon tuning — live preview on the dummy target · Save writes src/data/weapons.csv (dev only)';

/**
 * Cadence note shown in the rhythm panel. Stated verbatim in the UI and
 * pinned by the scene tests so the write/read-only contract cannot silently
 * drift (AH-0MW0WLZ9600693R9).
 */
export const WEAPON_RHYTHM_READ_ONLY_NOTE =
  'Rhythm rungs (k/n/rotation) are editable here; Save writes ' +
  'src/data/weapon-levels.json and reloads the live cadence (dev only). ' +
  'Production builds are read-only.';

/** Editable field keys, in panel order. */
export type WeaponTuningFieldKey =
  | 'bulletColor'
  | 'bulletShape'
  | 'bulletSize'
  | 'bulletLifetime'
  | 'bulletRim'
  | 'bulletTrail'
  | 'bulletThickness'
  | 'bulletFlame'
  | 'aoeTrigger'
  | 'aoeRadius'
  | 'orbitPods'
  | 'orbitRadius'
  | 'impactColor'
  | 'impactRadius'
  | 'impactDuration'
  | 'impactCue';

/** One editable control descriptor. */
export interface WeaponTuningControlSpec {
  /** Unique key, also the DOM data-attribute value. */
  readonly key: WeaponTuningFieldKey;
  /** Human-readable label. */
  readonly label: string;
  /** Native control kind. */
  readonly kind: 'number' | 'colour' | 'select' | 'text';
  /** Slider bounds (number controls only). */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Select options (select controls only). */
  readonly options?: readonly string[];
  /** Designer-facing tooltip. */
  readonly tooltip: string;
  /** Whether the field applies to this definition (row hidden otherwise). */
  readonly applicable: (definition: WeaponDefinition) => boolean;
}

/** The ordered control set the panel renders. */
export const WEAPON_TUNING_CONTROLS: readonly WeaponTuningControlSpec[] = [
  {
    key: 'bulletColor',
    label: 'bulletColor',
    kind: 'colour',
    tooltip: 'The bullet fill colour. Every weapon must keep a unique colour.',
    applicable: () => true,
  },
  {
    key: 'bulletShape',
    label: 'bulletShape',
    kind: 'select',
    options: VALID_BULLET_SHAPES,
    tooltip:
      'The bullet visual shape. Each weapon must resolve a unique canonical shape family.',
    applicable: () => true,
  },
  {
    key: 'bulletSize',
    label: 'bulletSize',
    kind: 'number',
    min: 0.1,
    max: 3,
    step: 0.05,
    tooltip: 'Bullet radius multiplier relative to the default.',
    applicable: () => true,
  },
  {
    key: 'bulletLifetime',
    label: 'bulletLifetime (s)',
    kind: 'number',
    min: 0.1,
    max: 6,
    step: 0.1,
    tooltip: 'Seconds the bullet lives; effective range = speed x lifetime.',
    applicable: () => true,
  },
  {
    key: 'bulletRim',
    label: 'bulletRim',
    kind: 'colour',
    tooltip: 'Optional neon rim/outline colour.',
    applicable: (definition) => definition.bulletRim !== undefined,
  },
  {
    key: 'bulletTrail',
    label: 'bulletTrail',
    kind: 'number',
    min: 0,
    max: 6,
    step: 0.1,
    tooltip: 'Optional trail length as a multiple of the bullet radius.',
    applicable: (definition) => definition.bulletTrail !== undefined,
  },
  {
    key: 'bulletThickness',
    label: 'bulletThickness',
    kind: 'number',
    min: 0,
    max: 6,
    step: 0.1,
    tooltip: 'Optional stroke thickness for stroked shapes.',
    applicable: (definition) => definition.bulletThickness !== undefined,
  },
  {
    key: 'bulletFlame',
    label: 'bulletFlame',
    kind: 'number',
    min: 0,
    max: 6,
    step: 0.1,
    tooltip: 'Optional exhaust-flame length for powered projectiles.',
    applicable: (definition) => definition.bulletFlame !== undefined,
  },
  {
    key: 'aoeTrigger',
    label: 'aoeTrigger',
    kind: 'select',
    options: VALID_AOE_TRIGGERS,
    tooltip: 'When the area effect resolves (AOE family only).',
    applicable: (definition) => definition.aoe !== undefined,
  },
  {
    key: 'aoeRadius',
    label: 'aoeRadius (px)',
    kind: 'number',
    min: 0,
    max: 400,
    step: 1,
    tooltip: 'Area-effect radius in pixels (AOE family only).',
    applicable: (definition) => definition.aoe !== undefined,
  },
  {
    key: 'orbitPods',
    label: 'orbitPods',
    kind: 'number',
    min: 1,
    max: 12,
    step: 1,
    tooltip: 'Orbiting satellite-pod count (Options only).',
    applicable: (definition) => definition.orbit !== undefined,
  },
  {
    key: 'orbitRadius',
    label: 'orbitRadius (px)',
    kind: 'number',
    min: 1,
    max: 200,
    step: 1,
    tooltip: 'Orbit radius around the ship (Options only).',
    applicable: (definition) => definition.orbit !== undefined,
  },
  {
    key: 'impactColor',
    label: 'impactColor',
    kind: 'colour',
    tooltip: 'Impact-flash colour (weapons with an impact cue).',
    applicable: (definition) => definition.impactFx !== undefined,
  },
  {
    key: 'impactRadius',
    label: 'impactRadius (px)',
    kind: 'number',
    min: 0,
    max: 200,
    step: 1,
    tooltip: 'Impact-flash radius (weapons with an impact cue).',
    applicable: (definition) => definition.impactFx !== undefined,
  },
  {
    key: 'impactDuration',
    label: 'impactDuration (s)',
    kind: 'number',
    min: 0,
    max: 2,
    step: 0.01,
    tooltip: 'Impact-flash fade duration (weapons with an impact cue).',
    applicable: (definition) => definition.impactFx !== undefined,
  },
  {
    key: 'impactCue',
    label: 'impactCue',
    kind: 'text',
    tooltip:
      'Baked ToneForge impact cue export name from src/audio/effects.ts.',
    applicable: (definition) => definition.impactFx !== undefined,
  },
];

/** One rung of the read-only rhythm ladder, as the panel displays it. */
export interface WeaponRhythmRow {
  /** First weapon level the rung applies at. */
  readonly levelFrom: number;
  /** Last weapon level the rung applies at (`null` = unbounded). */
  readonly levelTo: number | null;
  /** Onsets per tile. */
  readonly k: number;
  /** Steps per tile. */
  readonly n: number;
  /** Phase shift in steps. */
  readonly rotation: number;
  /** Effective onsets per beat (80 BPM reference). */
  readonly onsetsPerBeat: number;
  /** Adjacent-onset interval for a straight rung, or `null` when irregular. */
  readonly intervalMs: number | null;
}

/**
 * The selected weapon's read-only rhythm ladder, rung by rung, from the live
 * `WEAPON_EUCLIDEAN_LADDERS` the fire scheduler uses. Pure, so the panel text
 * and its tests share one derivation.
 */
export function describeWeaponRhythm(weaponId: WeaponId): WeaponRhythmRow[] {
  const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
  return ladder.map((node, index) => {
    const next = ladder[index + 1];
    return {
      levelFrom: node.minLevel,
      levelTo: next === undefined ? null : next.minLevel - 1,
      k: node.pattern.k,
      n: node.pattern.n,
      rotation: node.pattern.rotation,
      onsetsPerBeat: node.onsetsPerBeat,
      intervalMs: isStraightEuclidean(node.pattern)
        ? euclideanOnsetIntervalMs(node.pattern)
        : null,
    };
  });
}

/**
 * The selected weapon's **authored** rhythm rungs (the editable data), from
 * the live `WEAPON_EUCLIDEAN_LADDER_SPECS` the scheduler resolves. Unlike
 * {@link describeWeaponRhythm} this keeps every authored rung (including any
 * above the fire-rate curve's asymptote) because it is the list a designer
 * edits and Saves, not the resolved display ladder. Pure.
 */
export function describeEditableWeaponRhythm(
  weaponId: WeaponId,
): WeaponLadderRung[] {
  return WEAPON_EUCLIDEAN_LADDER_SPECS[weaponId].map(
    ({ k, n, rotation }) => ({ k, n, rotation }),
  );
}

/** Highest previewable weapon level for `weaponId` (its last rung's min level). */
export function maxPreviewLevel(weaponId: WeaponId): number {
  const ladder = WEAPON_EUCLIDEAN_LADDERS[weaponId];
  return ladder.length === 0 ? 0 : ladder[ladder.length - 1].minLevel;
}

/** One-line rhythm summary for a single rung. */
export function formatWeaponRhythmRow(row: WeaponRhythmRow): string {
  const levelRange =
    row.levelTo === null
      ? `L${row.levelFrom}+`
      : row.levelFrom === row.levelTo
        ? `L${row.levelFrom}`
        : `L${row.levelFrom}–${row.levelTo}`;
  const interval =
    row.intervalMs === null
      ? 'irregular'
      : `${Number(row.intervalMs.toFixed(1))} ms onset gap`;
  return (
    `${levelRange} · E(${row.k},${row.n}) rot ${row.rotation} · ` +
    `${Number(row.onsetsPerBeat.toFixed(2))} onsets/beat · ${interval}`
  );
}

/** Reads a control's display value from a definition. */
export function readWeaponControlValue(
  definition: WeaponDefinition,
  key: WeaponTuningFieldKey,
): string {
  switch (key) {
    case 'bulletColor':
      return colorToHex(definition.bulletColor);
    case 'bulletShape':
      return definition.bulletShape;
    case 'bulletSize':
      return String(definition.bulletSize);
    case 'bulletLifetime':
      return String(definition.bulletLifetime);
    case 'bulletRim':
      return definition.bulletRim === undefined
        ? ''
        : colorToHex(definition.bulletRim);
    case 'bulletTrail':
      return definition.bulletTrail === undefined
        ? ''
        : String(definition.bulletTrail);
    case 'bulletThickness':
      return definition.bulletThickness === undefined
        ? ''
        : String(definition.bulletThickness);
    case 'bulletFlame':
      return definition.bulletFlame === undefined
        ? ''
        : String(definition.bulletFlame);
    case 'aoeTrigger':
      return definition.aoe?.trigger ?? 'onFire';
    case 'aoeRadius':
      return definition.aoe === undefined
        ? ''
        : String(definition.aoe.radius);
    case 'orbitPods':
      return definition.orbit === undefined
        ? ''
        : String(definition.orbit.pods);
    case 'orbitRadius':
      return definition.orbit === undefined
        ? ''
        : String(definition.orbit.radius);
    case 'impactColor':
      return definition.impactFx === undefined
        ? ''
        : colorToHex(definition.impactFx.color);
    case 'impactRadius':
      return definition.impactFx === undefined
        ? ''
        : String(definition.impactFx.radius);
    case 'impactDuration':
      return definition.impactFx === undefined
        ? ''
        : String(definition.impactFx.duration);
    case 'impactCue':
      return definition.impactFx?.cue ?? '';
  }
}

/** Parses a finite number, or `null` when the cell is blank/invalid. */
function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Parses a `#rrggbb` colour, or `null` when invalid. */
function parseColour(raw: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(raw.trim());
  if (match === null) return null;
  return hexToColor(`#${match[1]}`);
}

/**
 * Applies one control value to a copy of `definition`. Invalid input leaves
 * the field untouched, so a partially typed number can never corrupt the live
 * preview; blank optional fields clear the capability.
 */
export function applyWeaponControlValue(
  definition: WeaponDefinition,
  key: WeaponTuningFieldKey,
  raw: string,
): WeaponDefinition {
  const next = cloneWeaponDefinition(definition);
  switch (key) {
    case 'bulletColor': {
      const colour = parseColour(raw);
      if (colour !== null) next.bulletColor = colour;
      return next;
    }
    case 'bulletShape': {
      if ((VALID_BULLET_SHAPES as readonly string[]).includes(raw)) {
        next.bulletShape = raw as BulletShape;
      }
      return next;
    }
    case 'bulletSize': {
      const value = parseNumber(raw);
      if (value !== null && value > 0) next.bulletSize = value;
      return next;
    }
    case 'bulletLifetime': {
      const value = parseNumber(raw);
      if (value !== null && value > 0) next.bulletLifetime = value;
      return next;
    }
    case 'bulletRim': {
      const colour = parseColour(raw);
      if (colour !== null) next.bulletRim = colour;
      return next;
    }
    case 'bulletTrail': {
      const value = parseNumber(raw);
      if (value === null) delete next.bulletTrail;
      else next.bulletTrail = value;
      return next;
    }
    case 'bulletThickness': {
      const value = parseNumber(raw);
      if (value === null) delete next.bulletThickness;
      else next.bulletThickness = value;
      return next;
    }
    case 'bulletFlame': {
      const value = parseNumber(raw);
      if (value === null) delete next.bulletFlame;
      else next.bulletFlame = value;
      return next;
    }
    case 'aoeTrigger': {
      if (
        next.aoe !== undefined &&
        (VALID_AOE_TRIGGERS as readonly string[]).includes(raw)
      ) {
        next.aoe = { ...next.aoe, trigger: raw as AoETrigger };
      }
      return next;
    }
    case 'aoeRadius': {
      const value = parseNumber(raw);
      if (next.aoe !== undefined && value !== null && value >= 0) {
        next.aoe = { ...next.aoe, radius: value };
      }
      return next;
    }
    case 'orbitPods': {
      const value = parseNumber(raw);
      if (next.orbit !== undefined && value !== null && value > 0) {
        next.orbit = { ...next.orbit, pods: value };
      }
      return next;
    }
    case 'orbitRadius': {
      const value = parseNumber(raw);
      if (next.orbit !== undefined && value !== null && value > 0) {
        next.orbit = { ...next.orbit, radius: value };
      }
      return next;
    }
    case 'impactColor': {
      const colour = parseColour(raw);
      if (next.impactFx !== undefined && colour !== null) {
        next.impactFx = { ...next.impactFx, color: colour };
      }
      return next;
    }
    case 'impactRadius': {
      const value = parseNumber(raw);
      if (next.impactFx !== undefined && value !== null && value >= 0) {
        next.impactFx = { ...next.impactFx, radius: value };
      }
      return next;
    }
    case 'impactDuration': {
      const value = parseNumber(raw);
      if (next.impactFx !== undefined && value !== null && value >= 0) {
        next.impactFx = { ...next.impactFx, duration: value };
      }
      return next;
    }
    case 'impactCue': {
      if (next.impactFx !== undefined) {
        next.impactFx = { ...next.impactFx, cue: raw.trim() };
      }
      return next;
    }
  }
}

/**
 * The gym's inert dummy target: an indestructible neon ring that takes hits so
 * the preview shows bullet colours, sizes, AOE blasts and impact cues exactly
 * as the shared collision path resolves them.
 *
 * Intentional divergence (documented in `docs/GYM_PARITY.md`): the game has no
 * static targets. `takeDamage()` keeps `alive` true, so no kill is ever
 * finalised — the target is a tuning fixture, not an enemy.
 */
class TuningTarget
  extends Phaser.GameObjects.Graphics
  implements CombatEnemyEntity
{
  alive = true;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, { x, y });
    this.lineStyle(2, 0x44ff88, 1);
    this.strokeCircle(0, 0, 22);
    this.strokeCircle(0, 0, 11);
  }

  getHitRadius(): number {
    return 22;
  }

  /** Never destroyed: the preview target must outlive every shot. */
  destroySelf(): void {}

  /** Absorbs a hit without dying (multi-hit seam keeps the kill path idle). */
  takeDamage(): {
    destroyed: boolean;
    phaseAdvanced: boolean;
    phase: number;
    hpRemaining: number;
  } {
    return { destroyed: false, phaseAdvanced: false, phase: 0, hpRemaining: 1 };
  }
}

/** Launch parameters accepted by {@link GymWeaponTuning}. */
export interface GymWeaponTuningData extends SceneSetupState {
  /** Initial weapon to tune (defaults to `cannon`). */
  weaponId?: WeaponId;
  /** Initial preview level (clamped to the weapon's ladder). */
  previewLevel?: number;
}

/**
 * Weapon tuning gym. Extends the shared {@link CombatScene} so auto-fire, AOE
 * dispatch/VFX, impact feedback and collision resolution are the shipped code;
 * only the scenario (a dummy target and the tuning UI) is gym-specific.
 */
export class GymWeaponTuning extends CombatScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  never
> {
  private player: Player | null = null;
  private target: TuningTarget | null = null;
  private panel: HTMLDivElement | null = null;
  private helpHandle: GymHelpHandle | null = null;
  private effectsRegistry = new EffectsRegistry();

  /** The weapon currently being tuned. */
  private selectedWeapon: WeaponId = 'cannon';
  /** Unsaved draft applied to the live catalogue. */
  private draft: WeaponDefinition = getPersistedWeaponDefinition('cannon');
  /** The rung being auditioned (weapon upgrade level). */
  private previewLevel = 0;
  /** Unsaved rhythm rung list for the selected weapon (the Save payload). */
  private rhythmDraft: WeaponLadderRung[] =
    describeEditableWeaponRhythm('cannon');
  /** Fires observed from the shared scheduler (test/UX seam). */
  private firedWeapons: WeaponId[] = [];

  constructor() {
    super({ key: GYM_WEAPON_TUNING_SCENE_KEY });
  }

  /** Gym family background decision: fixed representative level, no warp. */
  protected override backgroundLevel(): number | null {
    return gymBackgroundLevel();
  }

  create(data?: GymWeaponTuningData): void {
    this.resetRunState();
    this._createSceneBackground();

    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT * 0.62,
    });
    this.add.existing(this.player);
    // A captured/gym ship takes no steering input; aim it up the screen at the
    // dummy target so every preview shot is visible.
    this.player.setDefaultHeading(-Math.PI / 2);

    // Scripted-scene setup (AH-0MVRMHYJR000Y9H8): the shared applier makes a
    // supplied loadout/seed live before the first frame. The tuning panel then
    // takes over the preview loadout, so the gym always previews its selection.
    this._adoptCaptureSetup(data);

    addBackToIndexButton(this);
    this.helpHandle = addHelpButton(this, {
      gymKey: GYM_WEAPON_TUNING_SCENE_KEY,
      drops: [...WEAPON_IDS],
    });
    addBackToMenuOnEsc(this);

    const target = new TuningTarget(
      this,
      GAME_WIDTH / 2,
      GAME_HEIGHT * 0.62 - WEAPON_TUNING_TARGET_OFFSET,
    );
    this.add.existing(target);
    this.target = target;

    this.add.text(24, 20, WEAPON_TUNING_HINT, {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#88ffcc',
    });

    // Select the requested (or default) weapon *before* building the panel so
    // the controls seed from its definition.
    this._selectWeapon(data?.weaponId ?? 'cannon', data?.previewLevel ?? 0);
    this._buildPanel();
    this._applyPanelValues(this.draft);
    this._refreshRhythmPanel();
    this._renderRhythmEditors();
    this._applyPreviewLoadout();
    this._updateSummary();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.teardownRunState(),
    );
  }

  /** Resets shared and scene-owned per-run state. */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.target = null;
    this.panel = null;
    this.helpHandle = null;
    this.firedWeapons = [];
    this.selectedWeapon = 'cannon';
    this.previewLevel = 0;
    this.rhythmDraft = describeEditableWeaponRhythm('cannon');
  }

  /** Destroys the scene-owned objects on shutdown. */
  protected override teardownRunState(): void {
    super.teardownRunState();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    this.panel = null;
    this.player?.destroy();
    this.player = null;
    this.target?.destroy();
    this.target = null;
    this.helpHandle = null;
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /** One deterministic simulation step (seconds). */
  tick(dt: number): void {
    if (!this.player) return;
    // Shared player-control step (input → physics → auto-fire), so the preview
    // is the shipped scheduler at the selected rung.
    this._tickPlayer(dt);
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);
    // Shared collision pass: player bullets damage/AOE the dummy target and
    // resolve the per-weapon impact feedback.
    this._handleCollisions();
    this.effectsRegistry.tick(dt);
  }

  // ── Shared combat participant contract ──────────────────────────

  override getPlayer(): Player | null {
    return this.player;
  }

  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /** The dummy target is the only entity the shared passes may resolve. */
  protected override getEnemyEntities(): readonly CombatEnemyEntity[] {
    return this.target === null ? [] : [this.target];
  }

  /** The preview is threat-free: no enemy bullets exist. */
  protected override getEnemyBullets(): readonly CombatEnemyBullet[] {
    return [];
  }

  /** No enemy bullets exist, so this is a no-op. */
  protected override setEnemyBullets(_bullets: CombatEnemyBullet[]): void {}

  /** Shared auto-fire hook: records the fire and plays the weapon's cue. */
  protected override onWeaponFired(weaponId: WeaponId): void {
    this.firedWeapons.push(weaponId);
    if (this.firedWeapons.length > 64) this.firedWeapons.shift();
    playWeaponFireSound(weaponId);
  }

  // ── Public test / operator seams ────────────────────────────────

  /** The weapon currently being tuned. */
  getSelectedWeapon(): WeaponId {
    return this.selectedWeapon;
  }

  /** The unsaved draft currently applied to the live catalogue. */
  getDraftDefinition(): WeaponDefinition {
    return cloneWeaponDefinition(this.draft);
  }

  /** The live definition the preview ship fires (including the draft). */
  getLiveDefinition(): WeaponDefinition {
    return getLiveWeaponDefinition(this.selectedWeapon);
  }

  /** The rung being auditioned. */
  getPreviewLevel(): number {
    return this.previewLevel;
  }

  /** The shared help button/overlay handle (AH-0MUAYB67I002REOZ). */
  getHelpHandle(): GymHelpHandle | null {
    return this.helpHandle;
  }

  /** In-flight preview bullets (test seam). */
  getBullets(): PlayerBullet[] {
    return [...this.playerBullets];
  }

  /** The dummy target (test seam). */
  getTarget(): TuningTarget | null {
    return this.target;
  }

  /** Ids fired since the scene started (most recent last, bounded). */
  getFiredWeapons(): WeaponId[] {
    return [...this.firedWeapons];
  }

  /** Rhythm rows the panel renders for the selected weapon. */
  getRhythmRows(): WeaponRhythmRow[] {
    return describeWeaponRhythm(this.selectedWeapon);
  }

  /** The editable rhythm draft (the rungs Save would persist). */
  getRhythmDraft(): WeaponLadderRung[] {
    return this.rhythmDraft.map((rung) => ({ ...rung }));
  }

  /** The exact PUT body Save would send for the current rhythm draft. */
  getRhythmPayloadJson(): string {
    return buildWeaponLevelsWriteBody(this.selectedWeapon, this.rhythmDraft);
  }

  /** Selects a weapon for tuning (test seam; also drives the panel). */
  selectWeapon(weaponId: WeaponId, previewLevel = 0): void {
    this._selectWeapon(weaponId, previewLevel);
    if (this.panel) {
      this._applyPanelValues(this.draft);
      this._refreshRhythmPanel();
      this._renderRhythmEditors();
    }
    this._applyPreviewLoadout();
    this._updateSummary();
  }

  /** Sets the preview rung (test seam; also drives the level slider). */
  setPreviewLevel(level: number): void {
    this.previewLevel = this._clampPreviewLevel(level);
    this._applyPreviewLoadout();
    this._refreshRhythmPanel();
  }

  // ── Selection / preview loadout ─────────────────────────────────

  /** Switches the tuned weapon, dropping the previous weapon's draft. */
  private _selectWeapon(weaponId: WeaponId, previewLevel: number): void {
    if (this.selectedWeapon !== weaponId) {
      // Drop any unsaved edit so switching weapons shows the persisted row.
      restorePersistedWeaponDefinition(this.selectedWeapon);
    }
    this.selectedWeapon = weaponId;
    this.draft = getPersistedWeaponDefinition(weaponId);
    this.previewLevel = this._clampPreviewLevel(previewLevel);
    // Seed the editable rhythm draft from the weapon's authored ladder
    // (the JSON-backed rungs), so the panel edits the same data Save writes.
    this.rhythmDraft = describeEditableWeaponRhythm(weaponId);
  }

  /** Clamps a preview level to the weapon's authored ladder. */
  private _clampPreviewLevel(level: number): number {
    if (!Number.isFinite(level)) return 0;
    return Math.max(0, Math.min(this._maxPreviewLevel(), Math.floor(level)));
  }

  /**
   * Highest rung this weapon can preview. The permanent cannon is always
   * active and cannot be levelled through the collection API, so its preview
   * stays at level 0 (its full ladder is still shown for reference).
   */
  private _maxPreviewLevel(): number {
    return isTimedWeapon(this.selectedWeapon)
      ? maxPreviewLevel(this.selectedWeapon)
      : 0;
  }

  /**
   * Equips the selected weapon at the preview rung through the shared player
   * API, so the auto-fire scheduler plays the rung the panel highlights.
   *
   * `Player` resolves level `n` after `n + 1` permanent grants (the first
   * grant is the base rung), so the loop mirrors how a run earns the weapon.
   * The permanent cannon is always active and cannot be levelled through the
   * collection API; its preview stays at level 0.
   */
  private _applyPreviewLoadout(): void {
    const player = this.player;
    if (!player) return;
    player.resetWeapon();
    player.resetWeaponLevels();
    player.setDefaultHeading(-Math.PI / 2);
    if (!isTimedWeapon(this.selectedWeapon)) return;
    for (let grant = 0; grant <= this.previewLevel; grant += 1) {
      player.equipWeapon(this.selectedWeapon, true);
    }
  }

  // ── Panel construction ──────────────────────────────────────────

  /** Builds the plain-DOM tuning panel (bottom-left, collapsible). */
  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    const panel = document.createElement('div');
    panel.id = WEAPON_TUNING_PANEL_ID;
    panel.className = 'gym-panel';

    panel.appendChild(this._weaponSelectRow());
    panel.appendChild(this._summaryRow());

    const optionalNote = document.createElement('p');
    optionalNote.textContent =
      'Optional visual fields (rim, trail, thickness, flame, impact) appear ' +
      'only when the weapon declares them; AOE/orbit controls appear for ' +
      'that family.';
    panel.appendChild(optionalNote);

    if (!isWeaponCatalogueWritable()) {
      const notice = document.createElement('p');
      notice.id = WEAPON_TUNING_READONLY_ID;
      notice.textContent =
        'Read-only build — weapon and rhythm writes are disabled. Values load ' +
        'from the bundled src/data/weapons.csv and src/data/weapon-levels.json.';
      panel.appendChild(notice);
    }

    for (const control of WEAPON_TUNING_CONTROLS) {
      panel.appendChild(this._controlRow(control));
    }

    panel.appendChild(this._rhythmSection());
    panel.appendChild(this._actionsRow());

    makeCollapsible({ panel, title: 'Weapon Tuning' });
    host.appendChild(panel);
    this.panel = panel;
  }

  /** The weapon selector row. */
  private _weaponSelectRow(): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = 'weapon';

    const select = document.createElement('select');
    select.id = WEAPON_TUNING_SELECT_ID;
    select.setAttribute('aria-label', 'Weapon to tune');
    for (const id of listWeaponIds()) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${id} — ${getPersistedWeaponDefinition(id).name}`;
      select.appendChild(option);
    }
    select.value = this.selectedWeapon;
    select.addEventListener('change', () => {
      this._selectWeapon(select.value as WeaponId, 0);
      this._applyPanelValues(this.draft);
      this._refreshRhythmPanel();
      this._applyPreviewLoadout();
      this._updateSummary();
    });

    row.append(label, select);
    return row;
  }

  /** The resolved-definition summary line. */
  private _summaryRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gym-panel-row';
    const summary = document.createElement('span');
    summary.id = WEAPON_TUNING_SUMMARY_ID;
    summary.setAttribute('aria-live', 'polite');
    row.appendChild(summary);
    return row;
  }

  /** One editable control row (hidden when inapplicable). */
  private _controlRow(control: WeaponTuningControlSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';
    row.setAttribute(WEAPON_TUNING_ROW_ATTR, control.key);

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = control.label;

    let input: HTMLInputElement | HTMLSelectElement;
    if (control.kind === 'select') {
      const select = document.createElement('select');
      for (const option of control.options ?? []) {
        const element = document.createElement('option');
        element.value = option;
        element.textContent = option;
        select.appendChild(element);
      }
      select.addEventListener('change', () => this._onControlInput());
      input = select;
    } else if (control.kind === 'colour') {
      const colour = document.createElement('input');
      colour.type = 'color';
      colour.addEventListener('input', () => this._onControlInput());
      input = colour;
    } else {
      const field = document.createElement('input');
      field.type = control.kind === 'number' ? 'number' : 'text';
      if (control.min !== undefined) field.min = String(control.min);
      if (control.max !== undefined) field.max = String(control.max);
      if (control.step !== undefined) field.step = String(control.step);
      field.addEventListener('input', () => this._onControlInput());
      input = field;
    }
    input.setAttribute(WEAPON_TUNING_FIELD_ATTR, control.key);
    input.setAttribute('aria-label', control.label);
    attachTooltip(input, control.tooltip);

    row.append(label, input);
    return row;
  }

  /** The editable rhythm ladder section. */
  private _rhythmSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'gym-panel-row';

    const heading = document.createElement('p');
    heading.textContent = 'Rhythm';
    section.appendChild(heading);

    const note = document.createElement('p');
    note.textContent = WEAPON_RHYTHM_READ_ONLY_NOTE;
    section.appendChild(note);

    const levelRow = document.createElement('label');
    levelRow.className = 'gym-panel-row';
    const levelLabel = document.createElement('span');
    levelLabel.className = 'gym-panel-label';
    levelLabel.textContent = 'preview rung';
    const level = document.createElement('input');
    level.id = WEAPON_TUNING_PREVIEW_LEVEL_ID;
    level.type = 'range';
    level.min = '0';
    level.step = '1';
    level.setAttribute('aria-label', 'Preview rung');
    level.addEventListener('input', () => {
      this.previewLevel = this._clampPreviewLevel(Number(level.value));
      this._applyPreviewLoadout();
      this._refreshRhythmPanel();
    });
    levelRow.append(levelLabel, level);
    section.appendChild(levelRow);

    // One editable k/n/rotation control set per authored rung.
    const editors = document.createElement('div');
    editors.id = WEAPON_TUNING_RHYTHM_EDITORS_ID;
    section.appendChild(editors);

    const rhythmStatus = document.createElement('p');
    rhythmStatus.id = WEAPON_TUNING_RHYTHM_STATUS_ID;
    rhythmStatus.setAttribute('aria-live', 'polite');
    section.appendChild(rhythmStatus);

    const rhythm = document.createElement('pre');
    rhythm.id = WEAPON_TUNING_RHYTHM_ID;
    rhythm.setAttribute('aria-live', 'polite');
    section.appendChild(rhythm);

    const nominal = document.createElement('p');
    nominal.id = WEAPON_TUNING_NOMINAL_ID;
    section.appendChild(nominal);

    return section;
  }

  /** Save / Save As / status row. */
  private _actionsRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gym-panel-actions';

    const writable = isWeaponCatalogueWritable();

    const save = document.createElement('button');
    save.id = WEAPON_TUNING_SAVE_ID;
    save.type = 'button';
    save.textContent = 'Save';
    save.disabled = !writable;
    attachTooltip(
      save,
      writable
        ? 'Upsert the current weapon row in src/data/weapons.csv and re-read it.'
        : 'Dev server only: a production build cannot write the committed CSV.',
    );
    save.addEventListener('click', () => void this._onSave());

    const saveAsInput = document.createElement('input');
    saveAsInput.id = WEAPON_TUNING_SAVE_AS_INPUT_ID;
    saveAsInput.type = 'text';
    saveAsInput.placeholder = 'New weapon id…';
    saveAsInput.setAttribute('aria-label', 'New weapon id');
    saveAsInput.disabled = !writable;

    const saveAs = document.createElement('button');
    saveAs.id = WEAPON_TUNING_SAVE_AS_ID;
    saveAs.type = 'button';
    saveAs.textContent = 'Save As…';
    saveAs.disabled = !writable;
    attachTooltip(
      saveAs,
      'Duplicate under a new id. Refused unless the id has a code fallback ' +
        'definition (icon + audio cue).',
    );
    saveAs.addEventListener('click', () => void this._onSaveAs());

    const status = document.createElement('span');
    status.id = WEAPON_TUNING_STATUS_ID;
    status.setAttribute('aria-live', 'polite');

    row.append(save, saveAsInput, saveAs, status);
    return row;
  }

  // ── Panel state ─────────────────────────────────────────────────

  /** Reads every applicable control into a fresh definition. */
  private _readPanelValues(): WeaponDefinition {
    let definition = cloneWeaponDefinition(this.draft);
    for (const control of WEAPON_TUNING_CONTROLS) {
      if (!control.applicable(definition)) continue;
      const input = this.panel?.querySelector<
        HTMLInputElement | HTMLSelectElement
      >(`[${WEAPON_TUNING_FIELD_ATTR}="${control.key}"]`);
      if (input === null || input === undefined) continue;
      definition = applyWeaponControlValue(definition, control.key, input.value);
    }
    return definition;
  }

  /** Seeds every control (and hides inapplicable rows) from `definition`. */
  private _applyPanelValues(definition: WeaponDefinition): void {
    if (!this.panel) return;
    for (const control of WEAPON_TUNING_CONTROLS) {
      const row = this.panel.querySelector<HTMLElement>(
        `[${WEAPON_TUNING_ROW_ATTR}="${control.key}"]`,
      );
      const applies = control.applicable(definition);
      if (row) row.hidden = !applies;
      const input = this.panel.querySelector<
        HTMLInputElement | HTMLSelectElement
      >(`[${WEAPON_TUNING_FIELD_ATTR}="${control.key}"]`);
      if (input === null || input === undefined || !applies) continue;
      input.value = readWeaponControlValue(definition, control.key);
    }
  }

  /** Any control edit applies the draft to the live preview catalogue. */
  private _onControlInput(): void {
    this.draft = this._readPanelValues();
    previewWeaponDefinition(this.draft);
    this._updateSummary();
  }

  /** Updates the resolved-definition summary line. */
  private _updateSummary(): void {
    const summary = this.panel?.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_SUMMARY_ID}`,
    );
    if (!summary) return;
    const definition = this.draft;
    const parts = [
      `${definition.id} — ${definition.name}`,
      `bullet ${colorToHex(definition.bulletColor)} ${definition.bulletShape}`,
      `size ${definition.bulletSize}`,
      `lifetime ${definition.bulletLifetime}s`,
    ];
    if (definition.aoe !== undefined) {
      parts.push(
        `aoe ${definition.aoe.trigger} r=${definition.aoe.radius}`,
      );
    }
    if (definition.orbit !== undefined) {
      parts.push(
        `orbit ${definition.orbit.pods} pods r=${definition.orbit.radius}`,
      );
    }
    if (definition.impactFx !== undefined) {
      parts.push(`impact ${definition.impactFx.cue}`);
    }
    summary.textContent = parts.join(' · ');
  }

  /** Rewrites the rhythm ladder summary and its legacy-nominal line. */
  private _refreshRhythmPanel(): void {
    if (!this.panel) return;
    const rows = describeWeaponRhythm(this.selectedWeapon);
    const activeRow = rows.find(
      (row) =>
        this.previewLevel >= row.levelFrom &&
        (row.levelTo === null || this.previewLevel <= row.levelTo),
    );

    const rhythm = this.panel.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_RHYTHM_ID}`,
    );
    if (rhythm) {
      const lines = rows.map(
        (row) =>
          `${row === activeRow ? '▶ ' : '  '}${formatWeaponRhythmRow(row)}`,
      );
      rhythm.textContent = lines.join('\n');
    }

    const nominal = this.panel.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_NOMINAL_ID}`,
    );
    if (nominal) {
      const subdivisions = DEFAULT_WEAPON_SUBDIVISIONS[this.selectedWeapon];
      nominal.textContent =
        `Legacy nominal (weapons.csv subdivisions): ${subdivisions}/beat — ` +
        'read-only; it does not drive the live cadence.' +
        (isTimedWeapon(this.selectedWeapon)
          ? ''
          : ' The permanent cannon previews at level 0; its full ladder is shown for reference.');
    }

    const level = this.panel.querySelector<HTMLInputElement>(
      `#${WEAPON_TUNING_PREVIEW_LEVEL_ID}`,
    );
    if (level) {
      level.max = String(this._maxPreviewLevel());
      level.value = String(this.previewLevel);
    }
  }

  // ── Editable rhythm controls ────────────────────────────────────

  /** Rebuilds the editable per-rung controls from the current draft. */
  private _renderRhythmEditors(): void {
    if (!this.panel) return;
    const host = this.panel.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_RHYTHM_EDITORS_ID}`,
    );
    if (!host) return;
    host.replaceChildren();
    const writable = isWeaponLevelsWritable();

    this.rhythmDraft.forEach((rung, index) => {
      const row = document.createElement('div');
      row.className = 'gym-panel-row';
      row.setAttribute(WEAPON_TUNING_RHYTHM_ROW_ATTR, String(index));

      const label = document.createElement('span');
      label.className = 'gym-panel-label';
      label.textContent = `rung ${index}`;
      row.appendChild(label);

      (['k', 'n', 'rotation'] as const).forEach((field) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = field === 'rotation' ? '0' : '1';
        input.step = '1';
        input.value = String(rung[field]);
        input.setAttribute(WEAPON_TUNING_RHYTHM_FIELD_ATTR, field);
        input.setAttribute('aria-label', `Rung ${index} ${field}`);
        input.disabled = !writable;
        if (writable) {
          input.addEventListener('input', () => this._onRhythmInput());
        }
        attachTooltip(
          input,
          field === 'k'
            ? 'Onsets per tile (1 <= k <= n).'
            : field === 'n'
              ? 'Steps per tile (n > 0).'
              : 'Phase shift in steps (0 <= rotation < n).',
        );
        row.appendChild(input);
      });
      host.appendChild(row);
    });
  }

  /** Reads the editable controls into a full rung list. */
  private _readRhythmEditors(): WeaponLadderRung[] {
    const host = this.panel?.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_RHYTHM_EDITORS_ID}`,
    );
    const rows =
      host?.querySelectorAll<HTMLElement>(`[${WEAPON_TUNING_RHYTHM_ROW_ATTR}]`) ??
      [];
    return [...rows].map((row) => {
      const read = (field: string): number => {
        const input = row.querySelector<HTMLInputElement>(
          `[${WEAPON_TUNING_RHYTHM_FIELD_ATTR}="${field}"]`,
        );
        return Number(input?.value ?? '0');
      };
      return { k: read('k'), n: read('n'), rotation: read('rotation') };
    });
  }

  /**
   * Any rung edit applies a validated, unsaved draft to the live preview so
   * the next shot plays it. An invalid draft is reported and **not** applied,
   * so the running rhythm is never silently re-timed (AC4).
   */
  private _onRhythmInput(): void {
    this.rhythmDraft = this._readRhythmEditors();
    const errors = validateWeaponLevelRungs(
      this.selectedWeapon,
      this.rhythmDraft,
    );
    if (errors.length > 0) {
      this._setRhythmStatus(errors.join('; '));
      return;
    }
    this._setRhythmStatus('');
    overrideWeaponLevelRungs(this.selectedWeapon, this.rhythmDraft);
    this._refreshRhythmPanel();
  }

  /** Updates the rhythm-draft diagnostic line. */
  private _setRhythmStatus(message: string): void {
    const status = this.panel?.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_RHYTHM_STATUS_ID}`,
    );
    if (status) status.textContent = message;
  }

  /** Updates the panel's status readout. */
  private _setStatus(message: string): void {
    const status = this.panel?.querySelector<HTMLElement>(
      `#${WEAPON_TUNING_STATUS_ID}`,
    );
    if (status) status.textContent = message;
  }

  // ── Save flows ──────────────────────────────────────────────────

  /**
   * Persists the current draft: the weapon row to `weapons.csv` **and** the
   * selected weapon's Euclidean rhythm to `weapon-levels.json`, then re-seeds
   * from the re-read data.
   */
  private async _onSave(): Promise<void> {
    if (!isWeaponCatalogueWritable() || !isWeaponLevelsWritable()) {
      this._setStatus(
        'Read-only build — weapon and rhythm writes are disabled (bundled data only).',
      );
      return;
    }

    // Validate the rhythm draft first: an invalid edit is rejected before
    // any file access, so the running rhythm is never silently re-timed.
    const rhythmErrors = validateWeaponLevelRungs(
      this.selectedWeapon,
      this.rhythmDraft,
    );
    if (rhythmErrors.length > 0) {
      this._setRhythmStatus(rhythmErrors.join('; '));
      this._setStatus(
        `Save failed — ${rhythmErrors.join('; ')}`,
      );
      return;
    }
    this._setRhythmStatus('');

    this._setStatus('Saving…');
    try {
      const result = await saveWeaponDefinition(this._readPanelValues());
      if (!result.ok) {
        this._setStatus(`Save failed — ${result.reason ?? 'writes unavailable'}`);
        return;
      }

      const rhythmResult = await saveWeaponLevels(
        this.selectedWeapon,
        this.rhythmDraft,
      );
      if (!rhythmResult.ok) {
        this._setStatus(
          `Save failed — ${rhythmResult.reason ?? 'rhythm writes unavailable'}`,
        );
        return;
      }

      this.draft = getPersistedWeaponDefinition(this.selectedWeapon);
      this._applyPanelValues(this.draft);
      // Re-seed the rhythm controls from the live (re-read) authored ladder.
      this.rhythmDraft = describeEditableWeaponRhythm(this.selectedWeapon);
      this._renderRhythmEditors();
      this._refreshRhythmPanel();
      this._updateSummary();
      const warnings =
        result.warnings !== undefined && result.warnings.length > 0
          ? ` (${result.warnings.join('; ')})`
          : '';
      this._setStatus(`Saved ${this.selectedWeapon} to src/data/weapons.csv${warnings}`);
    } catch (err) {
      this._setStatus(`Save failed: ${String(err)}`);
    }
  }

  /** Save As: refused for an unknown or duplicate id, with a visible reason. */
  private async _onSaveAs(): Promise<void> {
    if (!isWeaponCatalogueWritable()) {
      this._setStatus(
        'Read-only build — weapon writes are disabled (bundled CSV only).',
      );
      return;
    }
    const input = this.panel?.querySelector<HTMLInputElement>(
      `#${WEAPON_TUNING_SAVE_AS_INPUT_ID}`,
    );
    const raw = (input?.value ?? '').trim();
    if (raw === '') {
      this._setStatus('Enter a non-empty weapon id');
      return;
    }
    this._setStatus('Saving…');
    try {
      const result = await saveWeaponDefinitionAs(
        this._readPanelValues(),
        raw,
      );
      if (!result.ok) {
        this._setStatus(`Save As failed — ${result.reason ?? 'writes unavailable'}`);
        return;
      }
      if (input) input.value = '';
      this._setStatus(`Saved as ${raw}`);
    } catch (err) {
      this._setStatus(`Save As failed: ${String(err)}`);
    }
  }
}
