/**
 * Hex-map renderer — the one map screen used by the game's `HexMapScene` and
 * by `GymHexWar` (AH-0MVUXCAG90086LH2, part of **Build Candidate D — Hangar
 * War**).
 *
 * The map's content is the pure read model built by
 * `src/core/hangarWar/hexIntel.ts`: the hangar at the centre, the ring around
 * it, and every hex's known-ahead intel (held/unheld, aggression, boss,
 * strengths, weaknesses, granted weapon/upgrade and any pending attack). This
 * module only *draws* that model and wires its actionable hexes to the shared
 * `FocusManager`; it contains no rule, no resolver call and no state.
 *
 * **One screen code path.** The shipped `HexMapScene` renders this with
 * handlers (focus/click a hex to deploy, the hangar row to open the hangar)
 * and `GymHexWar` renders the **same** model and renderer with no handlers, so
 * the gym shows exactly what the game shows and can never drift from it
 * (AGENTS.md gym↔game parity, `docs/GYM_PARITY.md`).
 *
 * Layout is a pointy-top axial grid: ring 2's twelve hexes fit around the
 * hangar without overlapping. Each tile carries only its aggression (`AGG n`)
 * as a short, readable label (held/unheld stays encoded by tile colour), and
 * the focused hex's full known-ahead intel renders in the right-hand detail
 * panel — so nothing has to be squinted at to be read (AH-0MW3VG6WJ004HRI9).
 *
 * @module src/scenes/hangarWar/hexMap
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_HEX_ROW_PREFIX,
  type HexIntel,
  type HexMapModel,
} from '../../core/hangarWar/hexIntel';
import { FocusManager } from '../../utils/focusManager';

/** Bottom hint line (the shared keyboard controls). */
export const HEX_MAP_HINT =
  'tab/arrows move · enter/space deploys at the focused hex · ESC menu';

/** Tile edge length in pixels (ring 2 fits around the centre at this size). */
const HEX_SIZE = 50;

/** Axial origin of the hangar (the middle of the map). */
const CENTRE_X = GAME_WIDTH / 2;
const CENTRE_Y = 258;

/** Hangar marker edge length (smaller than a hex tile). */
const HANGAR_SIZE = 34;

/** Background/line colours for a held and an unheld tile. */
const HELD_FILL = 0x0a2a14;
const HELD_LINE = 0x00ff88;
const UNHELD_FILL = 0x2a0a0a;
const UNHELD_LINE = 0xff6666;
const HANGAR_FILL = 0x0a1a2a;
const HANGAR_LINE = 0x00ffff;

/** Text colours. */
const TEXT_COLOR = '#a8e8ff';
const HEADING_COLOR = '#00ffff';
const MUTED_COLOR = '#557788';

/** On-tile font size: the aggression badge must be readable at 960×540. */
const TILE_FONT_SIZE = '14px';

/** Right-hand detail panel: the focused hex's full intel. */
const PANEL_X = GAME_WIDTH - 260;
const PANEL_Y = 200;
const PANEL_HEADING = 'SELECTED HEX — FULL INTEL';

/** NS = north/south; pointy-top corner angle offset from the x axis. */
const CORNER_ANGLES = [30, 90, 150, 210, 270, 330].map(
  (degrees) => (degrees * Math.PI) / 180,
);

/** Rendering options. */
export interface HexMapRenderOptions {
  /** Bottom hint line (defaults to {@link HEX_MAP_HINT}). */
  readonly hint?: string;
}

/** The actions a rendered map invokes. */
export interface HexMapHandlers {
  /** Deploy at `hexId` (the hex was activated). */
  onDeploy(hexId: string): void;
  /** Open the hangar screen (the `◀ HANGAR` row). */
  onOpenHangar(): void;
}

/** One rendered row, exposed for tests and screen queries. */
export interface HexMapRow {
  /** Row key (`hex:<id>` or `hangar`). */
  key: string;
  /** Rendered text. */
  label: string;
  /** Whether the row can be activated in this render. */
  actionable: boolean;
  /** The Phaser text object rendering the row. */
  text: Phaser.GameObjects.Text;
}

/** The handle returned by {@link renderHexMap}. */
export interface HexMapView {
  /** The model rendered. */
  readonly model: HexMapModel;
  /** Every rendered row (deployable hexes clockwise, then the hangar). */
  readonly rows: readonly HexMapRow[];
  /** The focused row key, or `null` when nothing is focusable. */
  getFocusedKey(): string | null;
  /** The hex the detail panel currently shows, or `null` when the map has no hexes. */
  getPanelKey(): string | null;
  /** The detail panel's current text (the full known-ahead intel). */
  getPanelText(): string;
  /** Moves focus to `key` when it is focusable (deterministic test seam). */
  focusRow(key: string): boolean;
  /** Activates the focused row (what Enter/Space does). */
  activateFocused(): void;
  /** Destroys the rendered objects and detaches the keyboard listener. */
  destroy(): void;
}

/** Axial coordinate → screen pixel centre (pointy-top layout). */
function axialToPixel(q: number, r: number): { x: number; y: number } {
  return {
    x: CENTRE_X + HEX_SIZE * Math.sqrt(3) * (q + r / 2),
    y: CENTRE_Y + HEX_SIZE * 1.5 * r,
  };
}

/** The six corners of a pointy-top hex centred at `(x, y)`. */
function hexCorners(
  x: number,
  y: number,
  size: number,
): Array<{ x: number; y: number }> {
  return CORNER_ANGLES.map((angle) => ({
    x: x + size * Math.cos(angle),
    y: y + size * Math.sin(angle),
  }));
}

/** Draws one filled, outlined hexagon into `graphics`. */
function drawHexagon(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
  fill: number,
  line: number,
): void {
  const corners = hexCorners(x, y, size);
  graphics.fillStyle(fill, 0.55);
  graphics.lineStyle(2, line, 1);
  graphics.beginPath();
  graphics.moveTo(corners[0].x, corners[0].y);
  for (const corner of corners.slice(1)) {
    graphics.lineTo(corner.x, corner.y);
  }
  graphics.closePath();
  graphics.fillPath();
  graphics.strokePath();
}

/** Renders the hangar at the centre of the map. */
function renderHangarMarker(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  model: HexMapModel,
): void {
  const graphics = scene.add.graphics();
  drawHexagon(
    graphics,
    CENTRE_X,
    CENTRE_Y,
    HANGAR_SIZE,
    HANGAR_FILL,
    HANGAR_LINE,
  );
  objects.push(graphics);

  objects.push(
    scene.add
      .text(CENTRE_X, CENTRE_Y, `HANGAR\nR${model.ringIndex}`, {
        fontFamily: 'monospace',
        fontSize: '8px',
        color: HEADING_COLOR,
        align: 'center',
      })
      .setOrigin(0.5, 0.5),
  );
}

/** Renders the small "how to read this map" legend. */
function renderLegend(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
): void {
  const x = GAME_WIDTH - 260;
  const lines = [
    'READ THE MAP',
    'green tile — held',
    'red tile — unheld',
    'AGG n — tile aggression',
    'tab/arrows — focus a hex',
    'detail panel — full intel',
  ];
  lines.forEach((line, index) => {
    objects.push(
      scene.add.text(x, 112 + index * 14, line, {
        fontFamily: 'monospace',
        fontSize: index === 0 ? '10px' : '9px',
        color: index === 0 ? HEADING_COLOR : MUTED_COLOR,
      }),
    );
  });
}

/** Draws and labels one hex tile; returns the tile's text object. */
function renderHexTile(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  intel: HexIntel,
): Phaser.GameObjects.Text {
  const { x, y } = axialToPixel(intel.q, intel.r);
  const graphics = scene.add.graphics();
  drawHexagon(
    graphics,
    x,
    y,
    HEX_SIZE,
    intel.held ? HELD_FILL : UNHELD_FILL,
    intel.held ? HELD_LINE : UNHELD_LINE,
  );
  objects.push(graphics);

  const text = scene.add
    .text(x, y, intel.tileLabel, {
      fontFamily: 'monospace',
      fontSize: TILE_FONT_SIZE,
      color: TEXT_COLOR,
      align: 'center',
    })
    .setOrigin(0.5, 0.5);
  objects.push(text);
  return text;
}

/**
 * Renders the hex map model and wires its deployable rows to the shared
 * `FocusManager`.
 *
 * An unheld hex is deployable — activating it (Enter/Space on focus, or a
 * pointer click on its tile) invokes `onDeploy`; held hexes are drawn with
 * their full intel but are not focusable, because the player already owns
 * them. The `◀ HANGAR` row is always actionable and invokes `onOpenHangar`.
 * A render with no handlers (the read-only `GymHexWar` parity scene) shows the
 * same map but reports every row as non-actionable, so nothing can be
 * activated there.
 *
 * @param scene — the scene that owns the rendered objects.
 * @param model — the model to render (from `buildHexMapModel`).
 * @param handlers — the actions the rows invoke (omit to render read-only).
 * @param options — rendering knobs (the bottom hint line).
 * @returns the view handle.
 */
export function renderHexMap(
  scene: Phaser.Scene,
  model: HexMapModel,
  handlers?: Partial<HexMapHandlers>,
  options?: HexMapRenderOptions,
): HexMapView {
  const objects: Phaser.GameObjects.GameObject[] = [];
  const rows: HexMapRow[] = [];
  const focusManager = new FocusManager();

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, 18, model.title, {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: HEADING_COLOR,
      })
      .setOrigin(0.5, 0),
  );
  objects.push(
    scene.add.text(24, 62, model.ringLine, {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: TEXT_COLOR,
    }),
  );
  objects.push(
    scene.add.text(24, 82, model.hangarLine, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: TEXT_COLOR,
    }),
  );

  renderHangarMarker(scene, objects, model);
  renderLegend(scene, objects);

  for (const intel of model.hexes) {
    const text = renderHexTile(scene, objects, intel);
    const deployable = intel.actionable && handlers?.onDeploy !== undefined;
    rows.push({
      key: intel.key,
      label: intel.tileLabel,
      actionable: deployable,
      text,
    });

    if (!deployable || !handlers?.onDeploy) continue;
    const deploy = (): void => handlers.onDeploy!(intel.id);
    text.on('pointerover', () => text.setStyle({ color: '#ffffff' }));
    text.on('pointerout', () => text.setStyle({ color: TEXT_COLOR }));
    text.on('pointerdown', deploy);
    text.setInteractive({ useHandCursor: true });

    // The whole tile is clickable, not just the label glyphs.
    const { x, y } = axialToPixel(intel.q, intel.r);
    const zone = scene.add
      .zone(x, y, HEX_SIZE * Math.sqrt(3), HEX_SIZE * 2)
      .setInteractive({ useHandCursor: true });
    zone.on('pointerdown', deploy);
    objects.push(zone);

    focusManager.register(text, deploy);
  }

  const hangarText = scene.add.text(24, 468, model.hangarRow.label, {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: TEXT_COLOR,
  });
  objects.push(hangarText);
  const hangarRow: HexMapRow = {
    key: HEX_MAP_HANGAR_ROW_KEY,
    label: model.hangarRow.label,
    actionable: handlers?.onOpenHangar !== undefined,
    text: hangarText,
  };
  rows.push(hangarRow);
  if (handlers?.onOpenHangar) {
    const open = (): void => handlers.onOpenHangar!();
    hangarText.on('pointerover', () =>
      hangarText.setStyle({ color: '#ffffff' }),
    );
    hangarText.on('pointerout', () =>
      hangarText.setStyle({ color: TEXT_COLOR }),
    );
    hangarText.on('pointerdown', open);
    hangarText.setInteractive({ useHandCursor: true });
    focusManager.register(hangarText, open);
  }

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 10, options?.hint ?? HEX_MAP_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: MUTED_COLOR,
      })
      .setOrigin(0.5, 1),
  );

  focusManager.attachKeyboard(scene);

  const focusable = (): HexMapRow[] => rows.filter((row) => row.actionable);

  const focusedKey = (): string | null => {
    const index = focusManager.getFocusedIndex();
    if (index < 0) return null;
    return focusable()[index]?.key ?? null;
  };

  const focusRow = (key: string): boolean => {
    const list = focusable();
    const index = list.findIndex((row) => row.key === key);
    if (index < 0) return false;
    focusManager.setFocusedIndex(index);
    return true;
  };

  // ── Detail panel: the focused hex's full known-ahead intel ────
  const panelHeading = scene.add.text(PANEL_X, PANEL_Y, PANEL_HEADING, {
    fontFamily: 'monospace',
    fontSize: '10px',
    color: HEADING_COLOR,
  });
  objects.push(panelHeading);
  const panelBody = scene.add.text(PANEL_X, PANEL_Y + 16, '', {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: TEXT_COLOR,
    lineSpacing: 4,
  });
  objects.push(panelBody);

  let panelKey: string | null = null;
  const hexByKey = (key: string | null): HexIntel | undefined =>
    key === null ? undefined : model.hexes.find((hex) => hex.key === key);

  const updatePanel = (): void => {
    const focused = focusedKey();
    const isHexKey = (key: string | null): key is string =>
      key !== null && key.startsWith(HEX_MAP_HEX_ROW_PREFIX);

    let key: string | null;
    if (isHexKey(focused)) {
      key = focused;
    } else if (
      model.defaultFocusKey !== null &&
      model.defaultFocusKey.startsWith(HEX_MAP_HEX_ROW_PREFIX)
    ) {
      // Read-only render: nothing is focusable, so default to the model's
      // default/first hex (AC3) and the panel still shows detail.
      key = model.defaultFocusKey;
    } else {
      // A non-hex focus (e.g. the hangar row) → the map's first hex.
      key = model.hexes[0]?.key ?? null;
    }

    const hex = hexByKey(key);
    panelKey = hex?.key ?? null;
    panelBody.setText(hex ? hex.label : '');
    panelHeading.setText(
      hex ? `SELECTED HEX — ${hex.id.toUpperCase()}` : PANEL_HEADING,
    );
  };

  focusManager.setFocusChangeListener(updatePanel);
  if (model.defaultFocusKey !== null) focusRow(model.defaultFocusKey);
  updatePanel(); // Covers read-only renders, where nothing is focusable.

  return {
    model,
    rows,
    getFocusedKey(): string | null {
      return focusedKey();
    },
    focusRow,
    activateFocused(): void {
      focusManager.activateFocused();
    },
    getPanelKey(): string | null {
      return panelKey;
    },
    getPanelText(): string {
      return panelBody.text;
    },
    destroy(): void {
      focusManager.shutdown();
      for (const object of objects) object.destroy();
      objects.length = 0;
      rows.length = 0;
    },
  };
}
