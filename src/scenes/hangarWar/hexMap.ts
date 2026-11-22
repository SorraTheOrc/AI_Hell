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
 * ## Sections (AH-0MWL4QCVD007WOAM)
 *
 * The screen is laid out as **four content sections plus a controls footer**,
 * each drawn as a bordered, headed panel with a bounded rect, so every group of
 * information is distinguishable at a glance and by framing rather than by
 * colour (`docs/GYM_PARITY.md`, GDD §8.2):
 *
 * - `war-status` — ring progress, frontier strength and the hangar's hull and
 *   banked resources (`WAR STATUS`).
 * - `last-sortie` — the transient "what just happened" news: the run result,
 *   the banked win bonus and the hangar-assault outcome. Present only when the
 *   landing carries one of them, so there is never an empty headed box.
 * - `map` — the model's own title, the ring tiles, the attack arrows and the
 *   hangar marker.
 * - `selected-hex` — the focused hex's full intel **and** its attack row, so
 *   one hex is one story (`SELECTED HEX`).
 * - `controls` — the `READ THE MAP` legend, the keyboard hint line and the
 *   `◀ HANGAR` row (`CONTROLS`).
 *
 * The rects live in one table ({@link HEX_MAP_SECTION_RECTS}), the headings in
 * shared constants (`src/core/hangarWar/hexIntel.ts`), and the view publishes
 * the same list as {@link HexMapView.sections} — so the game and the parity gym
 * describe identical regions and cannot drift.
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
 * hangar without overlapping, inside the `map` section's rect. Each tile leads
 * with its aggression badge (`AGG n`) and ownership marker at the readable tile
 * size, with the axial coordinates `(q,r)` on a separate line below them, drawn
 * smaller (producer review AH-0MWDBI33V003QQ3U, 2026-11-15) — guidance, not
 * clutter; the focused hex's full known-ahead intel renders in the
 * `selected-hex` section — so nothing has to be squinted at to be read
 * (AH-0MW3VG6WJ004HRI9).
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
 * - **Attack row of the `selected-hex` section** — the report model's own row
 *   for the focused hex whenever it is **either** arrow endpoint (the attacked
 *   hex *or* its attacker-origin hex), and hidden otherwise. It sits under that
 *   hex's intel in the same panel (one hex, one story) and copies the row's
 *   text verbatim, so the map can never publish a second, drifting set of
 *   numbers (AGENTS.md gym↔game parity).
 *
 * Both are driven by the shipped model (`arrows` / `attackDetails`), never by
 * a scene-local rule, and both disappear when the transient record does.
 *
 * ## The hangar assault announcement (`AH-0MWEZZA4E0081NJ5`)
 *
 * When the model carries a resolved ring-end hangar assault (`model.assault`),
 * the renderer draws its block inside `last-sortie`, beside the run result and
 * the banked win bonus: the outcome headline (`RING WON …` / `HANGAR FALLS …`), the arithmetic
 * that produced it and the consequence (the next ring opens / the full campaign
 * reset). The text is the report model's own `assaultLine`, copied verbatim,
 * so the map can never publish a second, drifting set of assault numbers — and
 * because it is a read-only banner over the same map, the attract traversal
 * keeps its one total next action (deploy, or the hangar once secured) and
 * cannot stall on it.
 *
 * @module src/scenes/hangarWar/hexMap
 */

import Phaser from 'phaser';

import { GAME_WIDTH } from '../../core/constants';
import {
  CONTROLS_HEADING,
  HEX_MAP_HANGAR_ROW_KEY,
  LAST_SORTIE_HEADING,
  SELECTED_HEX_HEADING,
  WAR_STATUS_HEADING,
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
/** Outcome colours for the hangar-assault banner (ring won / hangar fell). */
const WON_COLOR = '#00ff88';
const FALLS_COLOR = '#ff6666';

/**
 * CVD-safe tile text colours (producer Q2 = b): blue for a held hex, orange
 * for an unheld one. Paired with the non-colour ownership marker in
 * `tileLabel`, ownership stays readable without relying on colour.
 */
const HELD_TEXT_COLOR = '#4da6ff';
const UNHELD_TEXT_COLOR = '#ffa64d';

/**
 * Tile text colour of the special mission the rotation offers this sortie
 * (`AH-0MWF0CWB7002MG2F`).
 *
 * Gold is decoration only: the `★ SPECIAL` tag the intel model puts in
 * `tileLabel` is the non-colour signal, so the offer stays legible for a
 * colour-blind player — the same rule the ownership marker follows.
 */
const SPECIAL_OFFER_TEXT_COLOR = '#ffe066';

/** Focus highlight on a tile: a white stroke, never an ownership-colour swap. */
const TILE_FOCUS_STROKE = '#ffffff';

/**
 * Colour of the held-hex `UPGRADE DEFENCES` action (parent
 * AH-0MWH48IEG00929GQ): the actionable green, kept distinct from the intel
 * body's blue and the attack row's own colours.
 */
const UPGRADE_ACTION_COLOR = '#00ff88';
const TILE_FOCUS_STROKE_WIDTH = 2;

/**
 * On-tile font size for the first label line: the aggression badge must be
 * readable at 960×540.
 */
const TILE_FONT_SIZE = '14px';

/**
 * Smaller on-tile font size for the axial-coordinates line below the
 * aggression badge (producer review AH-0MWDBI33V003QQ3U, 2026-11-15):
 * coordinates are glanceable secondary information, never header text.
 */
const COORD_FONT_SIZE = '10px';

/**
 * Vertical offset from a tile's centre to the coordinates/tag line below the
 * aggression badge (headline half-height + body half-height + a small gap).
 */
const TILE_BODY_OFFSET_Y = 15;

/**
 * ## Sections (AH-0MWL4QCVD007WOAM)
 *
 * Every group of information on the screen lives in one **bordered, headed
 * panel** with a bounded rect, so the groupings are distinguishable by frame
 * and heading rather than by colour:
 *
 * | Key | Holds |
 * |---|---|
 * | `war-status` | ring progress, frontier strength, hangar hull + banked resources |
 * | `last-sortie` | the transient run result, banked win bonus and assault outcome |
 * | `map` | the title, ring tiles, attack arrows and hangar marker |
 * | `selected-hex` | the focused hex's intel **and** its attack row |
 * | `controls` | the keyboard hint, the `READ THE MAP` legend and the hangar row |
 *
 * The rects are one table ({@link HEX_MAP_SECTION_RECTS}) so the layout cannot
 * drift between sections, and every section heading comes from a shared
 * constant in `hexIntel.ts` (the `map` section is headed by the model's own
 * title).
 */

/** The five sections the map screen is laid out in. */
export type HexMapSectionKey =
  | 'war-status'
  | 'last-sortie'
  | 'map'
  | 'selected-hex'
  | 'controls';

/** A bounded screen region, in 960×540 frame coordinates. */
export interface HexMapSectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One rendered section: its identity, heading and bounded rect. */
export interface HexMapSection {
  /** Section key (`war-status`, `last-sortie`, `map`, `selected-hex`, `controls`). */
  readonly key: HexMapSectionKey;
  /** The section's heading (from a shared constant; the map uses the model title). */
  readonly heading: string;
  /** The bounded region the section draws inside. */
  readonly rect: HexMapSectionRect;
}

/** Padding from a section's frame to its heading and body text. */
const SECTION_PADDING = 8;

/** Vertical space a section heading occupies above the body text. */
const SECTION_HEADING_HEIGHT = 18;

/** Section body font sizes: never below the map's existing 9px floor. */
const SECTION_HEADING_SIZE = '10px';
const SECTION_BODY_SIZE = '12px';

/** Section frame fill/stroke: a faint tint and one hairline, colour-independent. */
const SECTION_FILL = 0x03131c;
const SECTION_LINE = 0x1f4a5a;

/** Width of the map's left column (`war-status`, `last-sortie`). */
const SECTION_COLUMN_WIDTH = 241;

/**
 * Advance of the panels' monospace face, as a fraction of the font size
 * (0.6em — the metric a wrapped body line is budgeted with).
 *
 * The renderer itself lays text out from Phaser's measured metrics; this
 * constant exists so a panel's height can be budgeted from its worst-case
 * content without a live canvas (the test harness's canvas stub measures 0
 * width, so nothing ever wraps there — AH-0MWNEQRSI008DIY8).
 */
const MONOSPACE_ADVANCE_EM = 0.6;

/** Rendered line box of a body line, as a multiple of its font size. */
const SECTION_LINE_HEIGHT_EM = 1.25;

/**
 * One body block of a panel, as its height budget sees it: the visual lines it
 * may occupy, its type size and the spacing the layout puts around it.
 */
export interface SectionLineBudget {
  /** Visual lines the block may occupy at the panel's body width. */
  readonly visualLines: number;
  /** The block's font size in px. */
  readonly fontSizePx: number;
  /** Extra px between the block's own lines (`Text.lineSpacing`). */
  readonly lineSpacing: number;
  /** Extra px below the block (the layout's `gap`). */
  readonly gap: number;
}

/**
 * Visual lines `text` wraps into inside `widthPx` at `fontSizePx`.
 *
 * A deterministic stand-in for the browser's text measurement, so a panel's
 * worst-case content can be budgeted (and tested) without a real canvas.
 */
export function wrappedLineCount(
  text: string,
  widthPx: number,
  fontSizePx: number,
): number {
  const columns = Math.max(
    1,
    Math.floor(widthPx / (fontSizePx * MONOSPACE_ADVANCE_EM)),
  );
  return text
    .split('\n')
    .reduce(
      (lines, hardLine) => lines + Math.max(1, Math.ceil(hardLine.length / columns)),
      0,
    );
}

/** Height in px a panel's body blocks occupy at their budgeted line counts. */
export function sectionBudgetHeight(
  blocks: readonly SectionLineBudget[],
): number {
  return blocks.reduce(
    (height, block) =>
      height +
      block.visualLines * (block.fontSizePx * SECTION_LINE_HEIGHT_EM + block.lineSpacing) +
      block.gap,
    0,
  );
}

/**
 * The `last-sortie` panel's worst-case content budget (AH-0MWNEQRSI008DIY8).
 *
 * A full win landing draws five blocks in the panel's 225px body column: the
 * deployment's run result (`RUN: VICTORY · score N`, up to two visual lines),
 * the banked win bonus (one), the banked held-hex income (up to two, its amount
 * can run wide — AH-0MWL8CDGN005878A), the `HANGAR ASSAULT` sub-heading (one)
 * and the assault body — headline, numbers and consequence as three hard lines
 * that wrap to at most seven visual lines. The panel is sized **from this
 * budget**, so a longer line or a shorter panel fails the budget test instead
 * of bleeding out of the frame.
 */
export const LAST_SORTIE_LINE_BUDGET: readonly SectionLineBudget[] = [
  { visualLines: 2, fontSizePx: 13, lineSpacing: 2, gap: 4 },
  { visualLines: 1, fontSizePx: 11, lineSpacing: 2, gap: 4 },
  { visualLines: 2, fontSizePx: 11, lineSpacing: 2, gap: 4 },
  { visualLines: 1, fontSizePx: 10, lineSpacing: 2, gap: 2 },
  { visualLines: 7, fontSizePx: 11, lineSpacing: 2, gap: 0 },
];

/**
 * The `last-sortie` panel's height: its worst-case body budget plus the frame's
 * own padding and heading band, rounded up to whole pixels.
 */
export const LAST_SORTIE_HEIGHT = Math.ceil(
  SECTION_PADDING * 2 +
    SECTION_HEADING_HEIGHT +
    sectionBudgetHeight(LAST_SORTIE_LINE_BUDGET),
);

/**
 * The section layout at 960×540.
 *
 * The left column carries `war-status` and (when there is news)
 * `last-sortie`; the centre is the `map` (its rect bounds the ring-2 tiles at
 * `HEX_SIZE = 50` exactly); the right column is `selected-hex`; the footer band
 * is `controls`. No two rects overlap and every rect lies inside the frame.
 * `last-sortie` is sized from its worst-case content budget
 * ({@link LAST_SORTIE_HEIGHT}) so the full win path cannot spill out of it.
 */
export const HEX_MAP_SECTION_RECTS: Readonly<
  Record<HexMapSectionKey, HexMapSectionRect>
> = {
  'war-status': { x: 8, y: 8, width: SECTION_COLUMN_WIDTH, height: 140 },
  'last-sortie': {
    x: 8,
    y: 154,
    width: SECTION_COLUMN_WIDTH,
    height: LAST_SORTIE_HEIGHT,
  },
  map: { x: 253, y: 8, width: 454, height: 452 },
  'selected-hex': { x: 711, y: 8, width: 241, height: 452 },
  controls: { x: 8, y: 462, width: 944, height: 74 },
};

/** Left edge of a section's body text. */
function sectionBodyX(rect: HexMapSectionRect): number {
  return rect.x + SECTION_PADDING;
}

/** Top edge of a section's body text (below its heading). */
function sectionBodyY(rect: HexMapSectionRect): number {
  return rect.y + SECTION_PADDING + SECTION_HEADING_HEIGHT;
}

/** Word-wrap width of a section's body text. */
export function sectionBodyWidth(rect: HexMapSectionRect): number {
  return rect.width - SECTION_PADDING * 2;
}

/** Height available to a section's body text inside its rect. */
export function sectionBodyHeight(rect: HexMapSectionRect): number {
  return rect.height - SECTION_PADDING * 2 - SECTION_HEADING_HEIGHT;
}

/**
 * Draws one section's frame and heading, and returns the heading text object.
 *
 * One style for every section: a rounded, hairline-framed panel with a faint
 * fill and a monospace heading in the existing heading colour. The 20px map
 * title is the one exception — it is the map's own heading and stays centred
 * over the ring ({@link renderMapSection}).
 */
function drawSectionPanel(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  rect: HexMapSectionRect,
  heading: string,
): Phaser.GameObjects.Text {
  const frame = scene.add.graphics();
  frame.fillStyle(SECTION_FILL, 0.35);
  frame.lineStyle(1, SECTION_LINE, 0.9);
  frame.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 4);
  frame.strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 4);
  objects.push(frame);

  const text = scene.add.text(
    sectionBodyX(rect),
    rect.y + SECTION_PADDING - 2,
    heading,
    {
      fontFamily: 'monospace',
      fontSize: SECTION_HEADING_SIZE,
      color: HEADING_COLOR,
    },
  );
  objects.push(text);
  return text;
}

/**
 * Draws the `map` section: its frame and the model's own title, centred over
 * the ring. The tiles, arrows and hangar marker are drawn by their own
 * renderers inside this rect.
 */
function renderMapSection(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  model: HexMapModel,
): void {
  const rect = HEX_MAP_SECTION_RECTS.map;
  const frame = scene.add.graphics();
  frame.fillStyle(SECTION_FILL, 0.25);
  frame.lineStyle(1, SECTION_LINE, 0.9);
  frame.fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 4);
  frame.strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 4);
  objects.push(frame);
  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, rect.y + 10, model.title, {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: HEADING_COLOR,
      })
      .setOrigin(0.5, 0),
  );
}

/**
 * Draws the `war-status` section: ring progress, frontier strength and the
 * hangar's hull/banked resources. Body lines word-wrap inside the panel so a
 * long frontier line never overdraws the ring.
 */
function renderWarStatusSection(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  model: HexMapModel,
): void {
  const rect = HEX_MAP_SECTION_RECTS['war-status'];
  drawSectionPanel(scene, objects, rect, WAR_STATUS_HEADING);
  const x = sectionBodyX(rect);
  const wrap = sectionBodyWidth(rect);
  let y = sectionBodyY(rect);
  const lines = [
    { text: model.ringLine, fontSize: '13px' },
    { text: model.frontierLine, fontSize: SECTION_BODY_SIZE },
    { text: model.hangarLine, fontSize: SECTION_BODY_SIZE },
  ];
  for (const line of lines) {
    const body = scene.add.text(x, y, line.text, {
      fontFamily: 'monospace',
      fontSize: line.fontSize,
      color: TEXT_COLOR,
      lineSpacing: 2,
      wordWrap: { width: wrap },
    });
    objects.push(body);
    y += body.height + 4;
  }
}

/**
 * The `selected-hex` section: the focused hex's full intel **and** its
 * rolled-in attack row, in one bounded panel (one hex, one section).
 */
const SELECTED_HEX_RECT = HEX_MAP_SECTION_RECTS['selected-hex'];
const SELECTED_HEX_BODY_X = sectionBodyX(SELECTED_HEX_RECT);
const SELECTED_HEX_BODY_Y = sectionBodyY(SELECTED_HEX_RECT);
const SELECTED_HEX_BODY_WIDTH = sectionBodyWidth(SELECTED_HEX_RECT);

/** Gap between the intel body and the attack row's sub-heading below it. */
const SELECTED_HEX_ATTACK_GAP = 10;

/**
 * Sub-heading of the focused hex's attack row (the rolled-in defence report).
 * Hidden with the row itself when the focused hex is in no attack.
 */
const ATTACK_PANEL_HEADING = 'ATTACK — FOCUSED HEX';

/**
 * The held-hex `UPGRADE DEFENCES` action (parent AH-0MWH48IEG00929GQ).
 *
 * Surfaced in the `selected-hex` section when the focused hex is **held** and
 * has a defender (and the render was given an `onUpgradeDefences` handler).
 * Activating it opens the bot-upgrade screen for that defender; an unheld hex
 * (or the read-only gym render, which passes no handlers) never shows it.
 */
export const UPGRADE_DEFENCES_LABEL = '▲ UPGRADE DEFENCES';

/**
 * Sub-heading of the hangar-assault outcome (`AH-0MWEZZA4E0081NJ5`) inside the
 * `last-sortie` section: the report model's own `assaultLine` follows it.
 */
const ASSAULT_BANNER_HEADING = 'HANGAR ASSAULT';

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
  /**
   * Open the bot-upgrade screen for the defender of held `hexId` (the
   * `UPGRADE DEFENCES` action, parent AH-0MWH48IEG00929GQ). Omitted by the
   * read-only `GymHexWar` render, so it offers no upgrade action.
   */
  onUpgradeDefences?(hexId: string): void;
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
  /**
   * The section registry: one `{ key, heading, rect }` per rendered section,
   * in reading order (`war-status`, `last-sortie` when the landing carries
   * news, `map`, `selected-hex`, `controls`).
   *
   * Every rendered text object, tile and arrow lies inside exactly one of
   * these rects, no two rects overlap and every rect lies inside the 960×540
   * frame. Publishing it from the one shared renderer means the game and the
   * parity gym describe the same screen regions (AGENTS.md gym↔game parity).
   */
  readonly sections: readonly HexMapSection[];
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
   * The `selected-hex` section's attack-row text (the focused attack's row),
   * or `''` when the focused hex is in no attack.
   */
  getLeftPanelText(): string;
  /** Whether the `selected-hex` section's attack row is showing. */
  isLeftPanelVisible(): boolean;
  /**
   * The hangar-assault banner's current text (the report model's own
   * `assaultLine`), or `''` when the map carries no assault.
   */
  getAssaultText(): string;
  /** Whether the hangar-assault banner is showing. */
  isAssaultVisible(): boolean;
  /** Moves focus to `key` when it is focusable (deterministic test seam). */
  focusRow(key: string): boolean;
  /** Activates the focused row (what Enter/Space does). */
  activateFocused(): void;
  /**
   * The `UPGRADE DEFENCES` action's current text, or `''` when the focused hex
   * offers none (an unheld/undefended hex, or a render with no handler).
   */
  getUpgradeText(): string;
  /** Whether the `UPGRADE DEFENCES` action is showing. */
  isUpgradeVisible(): boolean;
  /** The held hex the `UPGRADE DEFENCES` action targets, or `null`. */
  getUpgradeHexId(): string | null;
  /** Activates the `UPGRADE DEFENCES` action (what its click does). */
  activateUpgrade(): void;
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
        fontSize: '9px',
        color: HEADING_COLOR,
        align: 'center',
      })
      .setOrigin(0.5, 0.5),
  );
}

/**
 * Draws the `controls` footer: the `READ THE MAP` legend and the keyboard hint
 * line, inside the footer panel. The legend keeps every line it had, laid out
 * in two columns so it fits the band; help no longer competes with the
 * selected-hex intel for the right-hand column.
 */
function renderControlsSection(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  options?: HexMapRenderOptions,
): void {
  const rect = HEX_MAP_SECTION_RECTS.controls;
  drawSectionPanel(scene, objects, rect, CONTROLS_HEADING);

  const lines = [
    'READ THE MAP',
    'blue ● — held · orange ○ — unheld',
    '(q,r) — coordinates · AGG n — aggression',
    'arrows — spatial · tab — linear',
    'enter/space — inspect or deploy',
    'detail panel — full intel',
  ];
  const columnWidth = rect.width / 4;
  lines.forEach((line, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    objects.push(
      scene.add.text(
        sectionBodyX(rect) + column * columnWidth,
        rect.y + 20 + row * 11,
        line,
        {
          fontFamily: 'monospace',
          fontSize: index === 0 ? '10px' : '9px',
          color: index === 0 ? HEADING_COLOR : MUTED_COLOR,
        },
      ),
    );
  });

  objects.push(
    scene.add
      .text(
        GAME_WIDTH / 2,
        rect.y + rect.height - 4,
        options?.hint ?? HEX_MAP_HINT,
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: MUTED_COLOR,
        },
      )
      .setOrigin(0.5, 1),
  );
}

/** The two rendered halves of one hex tile's label. */
interface TileLabelTexts {
  /**
   * The headline — `AGG n` + ownership marker — at the readable tile size,
   * centred on the tile (also the row's focus/activation control).
   */
  readonly head: Phaser.GameObjects.Text;
  /**
   * The lower lines — axial coordinates and any tags — below the headline in
   * the smaller {@link COORD_FONT_SIZE}, or `null` when the label is a single
   * line.
   */
  readonly body: Phaser.GameObjects.Text | null;
}

/**
 * Whether the landing carries any transient `last-sortie` news: a run result,
 * a banked win bonus or a hangar-assault outcome. When it carries none, the
 * section — and its registry entry — is absent.
 */
function hasLastSortieNews(
  model: HexMapModel,
  options?: HexMapRenderOptions,
): boolean {
  return (
    (options?.runLine ?? null) !== null ||
    model.winBonusLine !== null ||
    model.hexIncomeLine !== null ||
    model.assaultLine !== null
  );
}

/**
 * Draws the `last-sortie` section: the transient "what just happened" news.
 *
 * The deployment's run result, the banked win bonus, the banked held-hex income
 * and the hangar-assault outcome are gathered here instead of arriving in three
 * corners of the screen. The section renders **only** when the landing carries
 * at least one of them, so a later entry shows no empty headed box, and every
 * string is the model's own (`options.runLine`, `model.winBonusLine`,
 * `model.hexIncomeLine`, `model.assaultLine`), copied verbatim.
 *
 * The panel's height comes from {@link LAST_SORTIE_LINE_BUDGET}
 * ({@link LAST_SORTIE_HEIGHT}), the worst case this function can draw — the
 * run result, the banked bonus, the banked income and the three hard-wrapped
 * assault lines — so the full win path's text cannot spill below its own frame
 * (AH-0MWNEQRSI008DIY8). The gaps and the `lineSpacing` below are the same
 * numbers that budget uses.
 *
 * @returns the assault body text object (the `getAssaultText()` seam), or
 * `null` when the landing carries no assault.
 */
function renderLastSortieSection(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  model: HexMapModel,
  options?: HexMapRenderOptions,
): Phaser.GameObjects.Text | null {
  const runLine = options?.runLine ?? null;
  const winBonusLine = model.winBonusLine;
  const hexIncomeLine = model.hexIncomeLine;
  const assaultLine = model.assaultLine;
  if (!hasLastSortieNews(model, options)) {
    return null;
  }

  const rect = HEX_MAP_SECTION_RECTS['last-sortie'];
  drawSectionPanel(scene, objects, rect, LAST_SORTIE_HEADING);
  const x = sectionBodyX(rect);
  const wrap = sectionBodyWidth(rect);
  let y = sectionBodyY(rect);

  const addLine = (
    text: string,
    fontSize: string,
    color: string,
    gap: number,
  ): Phaser.GameObjects.Text => {
    const line = scene.add.text(x, y, text, {
      fontFamily: 'monospace',
      fontSize,
      color,
      lineSpacing: 2,
      wordWrap: { width: wrap },
    });
    objects.push(line);
    y += line.height + gap;
    return line;
  };

  if (runLine !== null) addLine(runLine, '13px', TEXT_COLOR, 4);
  if (winBonusLine !== null) addLine(winBonusLine, '11px', WON_COLOR, 4);
  if (hexIncomeLine !== null) addLine(hexIncomeLine, '11px', WON_COLOR, 4);
  if (assaultLine === null) return null;

  addLine(ASSAULT_BANNER_HEADING, SECTION_HEADING_SIZE, HEADING_COLOR, 2);
  return addLine(
    assaultLine,
    '11px',
    model.campaignReset ? FALLS_COLOR : WON_COLOR,
    0,
  );
}

/**
 * Draws and labels one hex tile.
 *
 * The label is split so the aggression badge (line 1) renders at the readable
 * tile size while the axial coordinates (line 2) render smaller on their own
 * line below — the producer-reviewed layout (AH-0MWDBI33V003QQ3U, 2026-11-15).
 */
function renderHexTile(
  scene: Phaser.Scene,
  objects: Phaser.GameObjects.GameObject[],
  intel: HexIntel,
): TileLabelTexts {
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

  // The offered special mission is highlighted from the intel model's own
  // answer (`offeredNow`) — never from a scene-side rotation rule.
  const textColor = intel.specialMission?.offeredNow
    ? SPECIAL_OFFER_TEXT_COLOR
    : intel.held
      ? HELD_TEXT_COLOR
      : UNHELD_TEXT_COLOR;
  const lines = intel.tileLabel.split('\n');
  const head = scene.add
    .text(x, y, lines[0], {
      fontFamily: 'monospace',
      fontSize: TILE_FONT_SIZE,
      color: textColor,
      align: 'center',
    })
    .setOrigin(0.5, 0.5)
    .setDepth(TILE_LABEL_DEPTH);
  objects.push(head);

  let body: Phaser.GameObjects.Text | null = null;
  if (lines.length > 1) {
    body = scene.add
      .text(x, y + TILE_BODY_OFFSET_Y, lines.slice(1).join('\n'), {
        fontFamily: 'monospace',
        fontSize: COORD_FONT_SIZE,
        color: textColor,
        align: 'center',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(TILE_LABEL_DEPTH);
    objects.push(body);
  }
  return { head, body };
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

  // ── Sections: war-status (left), map (centre) and controls (footer) ──
  // Section panels are drawn first so every tile, arrow and label renders
  // above its panel's frame and faint fill.
  renderWarStatusSection(scene, objects, model);
  renderMapSection(scene, objects, model);
  renderControlsSection(scene, objects, options);
  // Transient news has one home: the run result, the banked win bonus and the
  // assault outcome are all in `last-sortie` (or the section is absent).
  const assaultBody = renderLastSortieSection(scene, objects, model, options);

  // ── Section registry ────────────────────────────────────────
  // One entry per rendered section, built from the same rect table the panels
  // are drawn from, so the published regions can never drift from the drawn
  // ones. `last-sortie` appears only when it rendered.
  const sections: HexMapSection[] = [
    {
      key: 'war-status',
      heading: WAR_STATUS_HEADING,
      rect: HEX_MAP_SECTION_RECTS['war-status'],
    },
    ...(hasLastSortieNews(model, options)
      ? [
          {
            key: 'last-sortie' as const,
            heading: LAST_SORTIE_HEADING,
            rect: HEX_MAP_SECTION_RECTS['last-sortie'],
          },
        ]
      : []),
    { key: 'map', heading: model.title, rect: HEX_MAP_SECTION_RECTS.map },
    {
      key: 'selected-hex',
      heading: SELECTED_HEX_HEADING,
      rect: HEX_MAP_SECTION_RECTS['selected-hex'],
    },
    {
      key: 'controls',
      heading: CONTROLS_HEADING,
      rect: HEX_MAP_SECTION_RECTS.controls,
    },
  ];

  renderHangarMarker(scene, objects, model);

  // Arrows sit above the tile fills but below the tile labels (depths set in
  // `renderAttackArrows` / `renderHexTile`), so they never hide a tile's text.
  const arrows = renderAttackArrows(scene, objects, model);

  // Reveal filter (AC1): only displayed hexes get a tile, a click zone or a
  // focusable row. The rule itself is the pure model's (`displayed`).
  const displayedHexes = model.hexes.filter((hex) => hex.displayed);
  const displayedHexByKey = new Map(
    displayedHexes.map((hex) => [hex.key, hex] as const),
  );
  const tileTextByKey = new Map<string, TileLabelTexts>();
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
    for (const [key, texts] of tileTextByKey) {
      const intel = displayedHexByKey.get(key);
      const isFocused = key === focused;
      const colour = intel?.held ? HELD_TEXT_COLOR : UNHELD_TEXT_COLOR;
      texts.head.setStyle({
        color: colour,
        stroke: isFocused ? TILE_FOCUS_STROKE : '',
        strokeThickness: isFocused ? TILE_FOCUS_STROKE_WIDTH : 0,
      });
      // The coordinates/tag line carries the same CVD-safe colour as the
      // badge (ownership never relies on colour alone) but no focus stroke —
      // the headline carries the focus highlight.
      if (texts.body !== null) texts.body.setStyle({ color: colour });
    }
  };

  for (const intel of displayedHexes) {
    const texts = renderHexTile(scene, objects, intel);
    const text = texts.head;
    tileTextByKey.set(intel.key, texts);
    const deployable = intel.actionable && handlers?.onDeploy !== undefined;
    // A held hex with a defender offers the bot-upgrade action (parent
    // AH-0MWH48IEG00929GQ); an unheld hex never does, and the read-only gym
    // render (no handlers) offers nothing.
    const upgradeable =
      intel.held &&
      intel.defender !== null &&
      handlers?.onUpgradeDefences !== undefined;
    const row: HexMapRow = {
      key: intel.key,
      label: intel.tileLabel,
      actionable: deployable,
      text,
    };
    rows.push(row);
    focusableRows.push(row);

    // Every displayed hex is selectable. Activation deploys at an unheld hex;
    // on a held hex with a defender it opens the bot-upgrade screen (the
    // `UPGRADE DEFENCES` action); otherwise it is a no-op, so an owned hex can
    // be inspected without risk of re-deploying (AC3).
    const activate = (): void => {
      if (deployable) handlers!.onDeploy!(intel.id);
      else if (upgradeable) handlers!.onUpgradeDefences!(intel.id);
    };

    // Hovering either label half shows the headline's focus stroke; clicking
    // anywhere on the tile selects or deploys.
    const hoverOn = (): void => {
      text.setStyle({
        stroke: TILE_FOCUS_STROKE,
        strokeThickness: TILE_FOCUS_STROKE_WIDTH,
      });
    };
    const hoverOff = (): void => paintTiles();

    if (handlers) {
      // Clicking a tile selects it; an unheld tile still deploys (unchanged).
      const selectOrDeploy = (): void => {
        if (deployable) handlers.onDeploy!(intel.id);
        else focusRow(intel.key);
      };
      text.on('pointerover', hoverOn);
      text.on('pointerout', hoverOff);
      text.on('pointerdown', selectOrDeploy);
      text.setInteractive({ useHandCursor: true });
      if (texts.body !== null) {
        // The coordinates line is not focusable itself, but the whole label
        // responds to the pointer like the headline does.
        texts.body.on('pointerover', hoverOn);
        texts.body.on('pointerout', hoverOff);
        texts.body.on('pointerdown', selectOrDeploy);
        texts.body.setInteractive({ useHandCursor: true });
      }

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

  // The `◀ HANGAR` row is the map's one-click hangar action. It lives at the
  // right-hand end of the controls footer (always on screen, always
  // actionable) and the model folds it into every navigation column, so the
  // arrows reach it from anywhere on the map.
  const controlsRect = HEX_MAP_SECTION_RECTS.controls;
  const hangarText = scene.add
    .text(
      controlsRect.x + controlsRect.width - SECTION_PADDING,
      controlsRect.y + 16,
      model.hangarRow.label,
      {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: TEXT_COLOR,
      },
    )
    .setOrigin(1, 0);
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

  // ── `selected-hex`: the focused hex's intel AND its attack row ────
  // One hex, one section: the full known-ahead intel and the rolled-in defence
  // report for the same hex render inside one bordered, headed panel, so
  // reading a hex is one story rather than two panels on opposite sides of the
  // screen. `attackDetails` is keyed by the attacked hex id AND its
  // attacker-origin id, so either focus resolves the same row.
  drawSectionPanel(scene, objects, SELECTED_HEX_RECT, SELECTED_HEX_HEADING);
  const panelBody = scene.add.text(
    SELECTED_HEX_BODY_X,
    SELECTED_HEX_BODY_Y,
    '',
    {
      fontFamily: 'monospace',
      fontSize: SECTION_BODY_SIZE,
      color: TEXT_COLOR,
      lineSpacing: 4,
      wordWrap: { width: SELECTED_HEX_BODY_WIDTH },
    },
  );
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

  // The attack row of the same section, under the intel body: its own
  // sub-heading plus the report model's row text, copied verbatim. Both are
  // hidden (never moved to another section) when the focused hex is in no
  // attack.
  const attackPanelHeading = scene.add.text(
    SELECTED_HEX_BODY_X,
    SELECTED_HEX_BODY_Y,
    ATTACK_PANEL_HEADING,
    {
      fontFamily: 'monospace',
      fontSize: SECTION_HEADING_SIZE,
      color: HEADING_COLOR,
    },
  );
  objects.push(attackPanelHeading);
  const attackPanelBody = scene.add.text(
    SELECTED_HEX_BODY_X,
    SELECTED_HEX_BODY_Y + 14,
    '',
    {
      fontFamily: 'monospace',
      fontSize: SECTION_BODY_SIZE,
      color: TEXT_COLOR,
      lineSpacing: 4,
      wordWrap: { width: SELECTED_HEX_BODY_WIDTH },
    },
  );
  objects.push(attackPanelBody);

  let attackPanelKey: string | null = null;
  const updateAttackPanel = (): void => {
    const hex = hexByKey(displayedHexKey());
    const detail = hex ? model.attackDetails.get(hex.id) : undefined;
    // The row follows the intel body, whose height depends on how much of the
    // hex is known ahead, so the sub-block is positioned after the intel text
    // is laid out — never at a fixed offset that could collide with it.
    const top = panelBody.y + panelBody.height + SELECTED_HEX_ATTACK_GAP;
    attackPanelHeading.setPosition(SELECTED_HEX_BODY_X, top);
    attackPanelBody.setPosition(SELECTED_HEX_BODY_X, top + 14);
    attackPanelKey = detail ? hex!.id : null;
    attackPanelBody.setText(detail?.label ?? '');
    attackPanelHeading.setVisible(detail !== undefined);
    attackPanelBody.setVisible(detail !== undefined);
  };

  // ── `selected-hex`: the held-hex `UPGRADE DEFENCES` action ────────
  // The one bot-upgrade control surface on the map (parent
  // AH-0MWH48IEG00929GQ). Shown only for a held, defended hex and only when
  // the render carries an `onUpgradeDefences` handler; the read-only gym render
  // therefore offers nothing. It is positioned below the intel/attack block so
  // it can never collide with a long intel label.
  const upgradeText = scene.add.text(
    SELECTED_HEX_BODY_X,
    SELECTED_HEX_BODY_Y,
    '',
    {
      fontFamily: 'monospace',
      fontSize: SECTION_BODY_SIZE,
      color: UPGRADE_ACTION_COLOR,
      wordWrap: { width: SELECTED_HEX_BODY_WIDTH },
    },
  );
  upgradeText.setInteractive({ useHandCursor: true });
  objects.push(upgradeText);

  let upgradeKey: string | null = null;
  const updateUpgradeRow = (): void => {
    const hex = hexByKey(displayedHexKey());
    const shown =
      hex !== undefined &&
      hex.held === true &&
      hex.defender !== null &&
      handlers?.onUpgradeDefences !== undefined;
    // Sit under whichever block last rendered (the attack row when present,
    // otherwise the intel body).
    const anchor = attackPanelBody.visible
      ? attackPanelBody.y + attackPanelBody.height
      : panelBody.y + panelBody.height;
    upgradeText.setPosition(
      SELECTED_HEX_BODY_X,
      anchor + SELECTED_HEX_ATTACK_GAP,
    );
    upgradeKey = shown ? hex!.id : null;
    upgradeText.setText(shown ? UPGRADE_DEFENCES_LABEL : '');
    upgradeText.setVisible(shown);
  };

  const activateUpgrade = (): void => {
    if (upgradeKey !== null) handlers?.onUpgradeDefences?.(upgradeKey);
  };
  upgradeText.on('pointerdown', activateUpgrade);

  const updatePanel = (): void => {
    paintTiles();
    const hex = hexByKey(displayedHexKey());
    panelKey = hex?.key ?? null;
    // The section heading is the shared `SELECTED HEX` constant; the focused
    // hex's identity and its full known-ahead intel stay in the body, so no
    // information the old titled panel carried is lost.
    panelBody.setText(
      hex
        ? `FULL INTEL — ${hex.id.toUpperCase()}\n${hex.label}`
        : 'FULL INTEL — no hex in view',
    );
    updateAttackPanel();
    updateUpgradeRow();
  };

  focusManager.setFocusChangeListener(updatePanel);
  if (model.defaultFocusKey !== null) focusRow(model.defaultFocusKey);
  updatePanel(); // Covers read-only renders, where nothing is focusable.

  return {
    model,
    sections,
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
    getUpgradeText(): string {
      return upgradeText.text;
    },
    isUpgradeVisible(): boolean {
      return upgradeKey !== null && upgradeText.visible;
    },
    getUpgradeHexId(): string | null {
      return upgradeKey;
    },
    activateUpgrade,
    getAssaultText(): string {
      return assaultBody?.text ?? '';
    },
    isAssaultVisible(): boolean {
      return assaultBody !== null && assaultBody.visible;
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
