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
 * ## Reveal, CVD-safe ownership and owned-hex selection
 * (renderer item AH-0MWEWYUAS002P7P9, parent AH-0MWDBI33V003QQ3U)
 *
 * - **Reveal filter.** Only the model's `displayed` hexes are drawn; a hidden
 *   hex gets no tile, no click zone and no focusable row. The rule lives in the
 *   pure model (`isHexDisplayed`), never here.
 * - **CVD-safe tile text.** A tile's text is blue when the hex is held and
 *   orange when it is unheld (the colour-vision-deficiency-safe pair), and the
 *   label also carries a non-colour ownership marker (filled = held, hollow =
 *   unheld) so ownership is readable without colour. Focusing a tile highlights
 *   it with a stroke, never a colour swap, so the encoding survives focus.
 * - **Selectable vs deployable.** Every displayed hex is focusable, so a held
 *   hex can be inspected in the detail panel; activating a held hex performs no
 *   deployment. Only an unheld displayed hex deploys.
 *
 * ## Spatial arrow navigation (navigation item AH-0MWEWYVD7008PPQT)
 *
 * The renderer opts the shared `FocusManager` into its **grid** navigation mode
 * (shipped by AH-0MV1BKZ0J00946EX) with the columns the pure model already
 * publishes (`model.gridColumns`): ArrowLeft/ArrowRight move across columns
 * (wrapping, clamping into shorter columns) and ArrowUp/ArrowDown move within
 * the current column (wrapping). The model folds the `◀ HANGAR` row in as every
 * column's bottom row, so arrows reach it from anywhere on the map. Tab and
 * Shift+Tab keep their linear reading-order cycling — this module supplies no
 * navigation rule of its own, only the row-key → control-index mapping.
 *
 * Layout is a pointy-top axial grid: ring 2's twelve hexes fit around the
 * hangar without overlapping. Each tile carries its axial coordinates `(q,r)`,
 * its aggression (`AGG n`) and the ownership marker at the readable tile size,
 * and the focused hex's full known-ahead intel renders in the right-hand detail
 * panel — so nothing has to be squinted at to be read (AH-0MW3VG6WJ004HRI9).
 *
 * ## Rolled-in defence report (`AH-0MWDC3L9I008INDP`)
 *
 * When the map carries a between-sortie tick record, this renderer also draws
 * the report the record describes:
 *
 * - **Attack arrows** — one per `model.arrows` entry, from the attacker-origin
 *   hex to the attacked hex, both positioned with the map's own
 *   {@link axialToPixel} layout (the record only supplies the origin's axial
 *   coordinates; the target's come from its rendered tile, so the renderer
 *   never invents geometry for a hex the map does not show).
 * - **Left-hand attack panel** — the report model's own row for the focused
 *   hex whenever it is **either** arrow endpoint (the attacked hex *or* its
 *   attacker-origin hex), and hidden otherwise. It copies the row's text
 *   verbatim, so the map can never publish a second, drifting set of numbers
 *   (AGENTS.md gym↔game parity).
 *
 * Both are driven by the shipped model (`arrows` / `attackDetails`), never by
 * a scene-local rule, and both disappear when the transient record does.
 *
 * @module src/scenes/hangarWar/hexMap
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  HEX_MAP_HANGAR_ROW_KEY,
  type HexIntel,
  type HexMapModel,
} from '../../core/hangarWar/hexIntel';
import { FocusManager } from '../../utils/focusManager';

/**
 * Bottom hint line (the shared keyboard controls): arrows move spatially,
 * Tab/Shift+Tab cycle linearly, and Enter/Space activates (deploy on an unheld
 * hex, inspect on a held one).
 */
export const HEX_MAP_HINT =
  'arrows move spatially · tab cycles linearly · enter/space deploys or inspects · ESC menu';

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

/**
 * CVD-safe tile text colours (producer Q2 = b): blue for a held hex, orange
 * for an unheld one. Paired with the non-colour ownership marker in
 * `tileLabel`, ownership stays readable without relying on colour.
 */
const HELD_TEXT_COLOR = '#4da6ff';
const UNHELD_TEXT_COLOR = '#ffa64d';

/** Focus highlight on a tile: a white stroke, never an ownership-colour swap. */
const TILE_FOCUS_STROKE = '#ffffff';
const TILE_FOCUS_STROKE_WIDTH = 2;

/** On-tile font size: the aggression badge must be readable at 960×540. */
const TILE_FONT_SIZE = '14px';

/** Right-hand detail panel: the focused hex's full intel. */
const PANEL_X = GAME_WIDTH - 260;
const PANEL_Y = 200;
const PANEL_HEADING = 'SELECTED HEX — FULL INTEL';

/**
 * Left-hand attack panel (the rolled-in defence report).
 *
 * Sits in the left band under the ring/frontier/hangar header rows and above
 * the `◀ HANGAR` row, at a width that stays clear of the ring-2 tiles at
 * 960×540 (long numbers word-wrap inside the band rather than overdrawing a
 * tile), and hidden entirely when the focused hex is in no attack.
 */
const ATTACK_PANEL_X = 24;
const ATTACK_PANEL_Y = 118;
const ATTACK_PANEL_WIDTH = 270;
const ATTACK_PANEL_HEADING = 'ATTACK — FOCUSED HEX';

/** Attack-arrow styling (drawn between the tile fills and the tile labels). */
const ARROW_COLOR = 0xffb347;
const ARROW_WIDTH = 3;
const ARROW_HEAD = 12;

/**
 * Display depths: the arrow line sits above the tile fills but below the tile
 * labels, so an arrow never hides the `AGG n` text it points between.
 */
const ARROW_DEPTH = 0.5;
const TILE_LABEL_DEPTH = 1;

/** NS = north/south; pointy-top corner angle offset from the x axis. */
const CORNER_ANGLES = [30, 90, 150, 210, 270, 330].map(
  (degrees) => (degrees * Math.PI) / 180,
);

/** Rendering options. */
export interface HexMapRenderOptions {
  /** Bottom hint line (defaults to {@link HEX_MAP_HINT}). */
  readonly hint?: string;
  /**
   * The finished deployment's result line (`RUN: VICTORY · score 1200`), or
   * `null`/absent when the map was entered without one (a plain menu/hangar
   * landing). Transient launch data like the tick record
   * (AH-0MWEXIOZZ009UX14).
   */
  readonly runLine?: string | null;
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

/**
 * One drawn attack arrow: the attacker-origin tile centre to the attacked tile
 * centre, both resolved with the map's own {@link axialToPixel} layout.
 *
 * The endpoints are the **semantic** arrow endpoints (the two tiles' centres)
 * — the drawn line is inset from both so it does not bury the tile labels.
 */
export interface HexMapArrow {
  /** Arrow key (`arrow:<hexId>`, from the model). */
  readonly key: string;
  /** The attacked hex (the arrow's head). */
  readonly hexId: string;
  /** The unheld neighbour the attack came from (the arrow's tail). */
  readonly attackerOriginId: string;
  /** The attacker-origin tile's pixel centre. */
  readonly from: { readonly x: number; readonly y: number };
  /** The attacked tile's pixel centre. */
  readonly to: { readonly x: number; readonly y: number };
}

/** The handle returned by {@link renderHexMap}. */
export interface HexMapView {
  /** The model rendered. */
  readonly model: HexMapModel;
  /** Every rendered row (deployable hexes clockwise, then the hangar). */
  readonly rows: readonly HexMapRow[];
  /** Every attack arrow drawn (one per rendered `model.arrows` entry). */
  readonly arrows: readonly HexMapArrow[];
  /** The focused row key, or `null` when nothing is focusable. */
  getFocusedKey(): string | null;
  /** The hex the detail panel currently shows, or `null` when the map has no hexes. */
  getPanelKey(): string | null;
  /** The detail panel's current text (the full known-ahead intel). */
  getPanelText(): string;
  /**
   * The left-hand attack panel's current text (the focused attack's row), or
   * `''` when the focused hex is in no attack.
   */
  getLeftPanelText(): string;
  /** Whether the left-hand attack panel is showing. */
  isLeftPanelVisible(): boolean;
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

/**
 * Draws one attack arrow from `from` to `to` into `graphics`.
 *
 * The line is inset from both tile centres (a short chord between adjacent
 * hexes) and finished with a two-stroke head, so the arrow reads as a
 * direction without overdrawing the tiles' labels.
 */
function drawAttackArrow(
  graphics: Phaser.GameObjects.Graphics,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const ux = dx / length;
  const uy = dy / length;
  // Adjacent hexes share an edge, so inset just enough to leave the centres
  // (and their labels) clear while keeping a visible chord.
  const inset = Math.min(26, length / 3);
  const tail = { x: from.x + ux * inset, y: from.y + uy * inset };
  const tip = { x: to.x - ux * inset, y: to.y - uy * inset };

  graphics.lineStyle(ARROW_WIDTH, ARROW_COLOR, 1);
  graphics.beginPath();
  graphics.moveTo(tail.x, tail.y);
  graphics.lineTo(tip.x, tip.y);
  graphics.strokePath();

  const wing = ARROW_HEAD * 0.6;
  graphics.beginPath();
  graphics.moveTo(tip.x, tip.y);
  graphics.lineTo(
    tip.x - ux * ARROW_HEAD + uy * wing,
    tip.y - uy * ARROW_HEAD - ux * wing,
  );
  graphics.moveTo(tip.x, tip.y);
  graphics.lineTo(
    tip.x - ux * ARROW_HEAD - uy * wing,
    tip.y - uy * ARROW_HEAD + ux * wing,
  );
  graphics.strokePath();
}

/**
 * Draws one arrow per `model.arrows` entry and returns the drawn descriptors.
 *
 * The attacker-origin pixel comes from the record's axial coordinates; the
 * target's from its rendered tile. A record naming a hex the map does not
 * render has no geometry to draw from, so that entry is skipped rather than
 * guessed at.
 */
function renderAttackArrows(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  model: HexMapModel,
): HexMapArrow[] {
  if (model.arrows.length === 0) return [];

  const tileById = new Map(model.hexes.map((hex) => [hex.id, hex] as const));
  const graphics = scene.add.graphics().setDepth(ARROW_DEPTH);
  objects.push(graphics);

  const arrows: HexMapArrow[] = [];
  for (const arrow of model.arrows) {
    const target = tileById.get(arrow.hexId);
    if (!target) continue;
    const from = axialToPixel(arrow.attackerOrigin.q, arrow.attackerOrigin.r);
    const to = axialToPixel(target.q, target.r);
    drawAttackArrow(graphics, from, to);
    arrows.push({
      key: arrow.key,
      hexId: arrow.hexId,
      attackerOriginId: arrow.attackerOriginId,
      from,
      to,
    });
  }
  return arrows;
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
    'blue ● — held · orange ○ — unheld',
    '(q,r) — coordinates · AGG n — aggression',
    'arrows — spatial · tab — linear',
    'enter/space — inspect or deploy',
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
      color: intel.held ? HELD_TEXT_COLOR : UNHELD_TEXT_COLOR,
      align: 'center',
    })
    .setOrigin(0.5, 0.5)
    .setDepth(TILE_LABEL_DEPTH);
  objects.push(text);
  return text;
}

/**
 * Renders the hex map model and wires its displayed rows to the shared
 * `FocusManager`.
 *
 * Only the model's `displayed` hexes are drawn. Every displayed hex is
 * selectable (focusable) — activating an unheld hex (Enter/Space on focus, or a
 * pointer click on its tile) invokes `onDeploy`, while activating a held hex
 * performs no deployment because the player already owns it. The `◀ HANGAR`
 * row is always actionable and invokes `onOpenHangar`. A render with no handlers
 * (the read-only `GymHexWar` parity scene) shows the same map and reports every
 * row as non-actionable, so nothing can be deployed or opened there.
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
  // The between-sortie run result line, centred under the title so it never
  // collides with the left-hand header rows or the attack panel band.
  const runLine = options?.runLine ?? null;
  if (runLine) {
    objects.push(
      scene.add
        .text(GAME_WIDTH / 2, 46, runLine, {
          fontFamily: 'monospace',
          fontSize: '13px',
          color: TEXT_COLOR,
        })
        .setOrigin(0.5, 0),
    );
  }
  objects.push(
    scene.add.text(24, 62, model.ringLine, {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: TEXT_COLOR,
    }),
  );
  objects.push(
    scene.add.text(24, 82, model.frontierLine, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: TEXT_COLOR,
    }),
  );
  objects.push(
    scene.add.text(24, 102, model.hangarLine, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: TEXT_COLOR,
    }),
  );

  renderHangarMarker(scene, objects, model);
  renderLegend(scene, objects);

  // Arrows sit above the tile fills but below the tile labels (depths set in
  // `renderAttackArrows` / `renderHexTile`), so they never hide a tile's text.
  const arrows = renderAttackArrows(scene, objects, model);

  // Reveal filter (AC1): only displayed hexes get a tile, a click zone or a
  // focusable row. The rule itself is the pure model's (`displayed`).
  const displayedHexes = model.hexes.filter((hex) => hex.displayed);
  const displayedHexByKey = new Map(
    displayedHexes.map((hex) => [hex.key, hex] as const),
  );
  const tileTextByKey = new Map<string, Phaser.GameObjects.Text>();
  const focusableRows: HexMapRow[] = [];

  const focusedKey = (): string | null => {
    const index = focusManager.getFocusedIndex();
    if (index < 0) return null;
    return focusableRows[index]?.key ?? null;
  };

  const focusRow = (key: string): boolean => {
    const index = focusableRows.findIndex((row) => row.key === key);
    if (index < 0) return false;
    focusManager.setFocusedIndex(index);
    return true;
  };

  /**
   * Repaints every tile with its CVD-safe ownership colour and puts the focus
   * highlight in the stroke (never the colour), so focusing a tile cannot
   * clobber the blue/orange ownership encoding (AC2).
   */
  const paintTiles = (): void => {
    const focused = focusedKey();
    for (const [key, text] of tileTextByKey) {
      const intel = displayedHexByKey.get(key);
      const isFocused = key === focused;
      text.setStyle({
        color: intel?.held ? HELD_TEXT_COLOR : UNHELD_TEXT_COLOR,
        stroke: isFocused ? TILE_FOCUS_STROKE : '',
        strokeThickness: isFocused ? TILE_FOCUS_STROKE_WIDTH : 0,
      });
    }
  };

  for (const intel of displayedHexes) {
    const text = renderHexTile(scene, objects, intel);
    tileTextByKey.set(intel.key, text);
    const deployable = intel.actionable && handlers?.onDeploy !== undefined;
    const row: HexMapRow = {
      key: intel.key,
      label: intel.tileLabel,
      actionable: deployable,
      text,
    };
    rows.push(row);
    focusableRows.push(row);

    // Every displayed hex is selectable. Activation deploys only at an unheld
    // hex; on a held hex (or a read-only render) it is a no-op, so an owned hex
    // can be inspected without risk of re-deploying (AC3).
    const activate = (): void => {
      if (deployable) handlers!.onDeploy!(intel.id);
    };

    if (handlers) {
      // Clicking a tile selects it; an unheld tile still deploys (unchanged).
      const selectOrDeploy = (): void => {
        if (deployable) handlers.onDeploy!(intel.id);
        else focusRow(intel.key);
      };
      text.on('pointerover', () =>
        text.setStyle({
          stroke: TILE_FOCUS_STROKE,
          strokeThickness: TILE_FOCUS_STROKE_WIDTH,
        }),
      );
      text.on('pointerout', () => paintTiles());
      text.on('pointerdown', selectOrDeploy);
      text.setInteractive({ useHandCursor: true });

      // The whole tile is clickable, not just the label glyphs.
      const { x, y } = axialToPixel(intel.q, intel.r);
      const zone = scene.add
        .zone(x, y, HEX_SIZE * Math.sqrt(3), HEX_SIZE * 2)
        .setInteractive({ useHandCursor: true });
      zone.on('pointerdown', selectOrDeploy);
      objects.push(zone);
    }

    focusManager.register(text, activate);
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
  focusableRows.push(hangarRow);
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
  }
  focusManager.register(hangarText, () => handlers?.onOpenHangar?.());

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 10, options?.hint ?? HEX_MAP_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: MUTED_COLOR,
      })
      .setOrigin(0.5, 1),
  );

  // Grid navigation (AH-0MWEWYVD7008PPQT): the pure model owns the spatial
  // columns; the renderer only maps their row keys onto the registered control
  // indices. The `◀ HANGAR` row is folded into every column by the model, so
  // the arrows reach it too. Tab/Shift+Tab stay linear in grid mode.
  const indexByKey = new Map(
    focusableRows.map((row, index) => [row.key, index] as const),
  );
  const gridColumns = model.gridColumns.map((column) =>
    column
      .map((key) => indexByKey.get(key))
      .filter((index): index is number => index !== undefined),
  );
  focusManager.attachKeyboard(scene, {
    navigation: 'grid',
    columns: gridColumns,
  });

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
    key === null ? undefined : displayedHexByKey.get(key);

  /** The displayed hex both panels describe: the focused hex, or the default. */
  const displayedHexKey = (): string | null => {
    const focused = focusedKey();
    if (focused !== null && displayedHexByKey.has(focused)) return focused;
    if (
      model.defaultFocusKey !== null &&
      displayedHexByKey.has(model.defaultFocusKey)
    ) {
      // Read-only render: nothing is focused, so default to the model's
      // default hex (AC3) and the panels still show detail.
      return model.defaultFocusKey;
    }
    // A non-hex focus (e.g. the hangar row) → the map's first displayed hex.
    return displayedHexes[0]?.key ?? null;
  };

  // ── Left panel: the rolled-in defence report ────────────────────
  // One attack, two endpoints: `attackDetails` is keyed by the attacked hex
  // id AND its attacker-origin id, so either focus resolves the same row.
  const attackPanelHeading = scene.add.text(
    ATTACK_PANEL_X,
    ATTACK_PANEL_Y,
    ATTACK_PANEL_HEADING,
    { fontFamily: 'monospace', fontSize: '10px', color: HEADING_COLOR },
  );
  objects.push(attackPanelHeading);
  const attackPanelBody = scene.add.text(
    ATTACK_PANEL_X,
    ATTACK_PANEL_Y + 16,
    '',
    {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: TEXT_COLOR,
      lineSpacing: 4,
      wordWrap: { width: ATTACK_PANEL_WIDTH },
    },
  );
  objects.push(attackPanelBody);

  let attackPanelKey: string | null = null;
  const updateAttackPanel = (): void => {
    const hex = hexByKey(displayedHexKey());
    const detail = hex ? model.attackDetails.get(hex.id) : undefined;
    attackPanelKey = detail ? hex!.id : null;
    attackPanelBody.setText(detail?.label ?? '');
    attackPanelHeading.setVisible(detail !== undefined);
    attackPanelBody.setVisible(detail !== undefined);
  };

  const updatePanel = (): void => {
    paintTiles();
    const hex = hexByKey(displayedHexKey());
    panelKey = hex?.key ?? null;
    panelBody.setText(hex ? hex.label : '');
    panelHeading.setText(
      hex ? `SELECTED HEX — ${hex.id.toUpperCase()}` : PANEL_HEADING,
    );
    updateAttackPanel();
  };

  focusManager.setFocusChangeListener(updatePanel);
  if (model.defaultFocusKey !== null) focusRow(model.defaultFocusKey);
  updatePanel(); // Covers read-only renders, where nothing is focusable.

  return {
    model,
    rows,
    arrows,
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
    getLeftPanelText(): string {
      return attackPanelBody.text;
    },
    isLeftPanelVisible(): boolean {
      return attackPanelKey !== null && attackPanelBody.visible;
    },
    destroy(): void {
      focusManager.shutdown();
      for (const object of objects) object.destroy();
      objects.length = 0;
      rows.length = 0;
      arrows.length = 0;
    },
  };
}
