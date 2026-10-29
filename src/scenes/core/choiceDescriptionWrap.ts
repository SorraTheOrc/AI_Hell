/**
 * Two-line wrapping for hold-full option descriptions (AH-0MVBLBSG3002WHBI).
 *
 * The hold-full choice overlay gives each option's description an area two
 * lines tall so longer catalogue copy stays readable instead of running past
 * the edge of the 960 px playfield. Phaser's built-in word wrap depends on
 * canvas font metrics, which are unavailable in the headless test harness
 * (`measureText` returns zero width) and vary slightly between browsers, so
 * the overlay wraps the copy itself against a conservative monospace
 * character budget. Wrapping is therefore deterministic: every rendered line
 * fits the 13 px monospace description style and the result can be asserted
 * exactly.
 *
 * The copy itself is unchanged — only its layout is decided here. When the
 * description needs more than {@link CHOICE_DESCRIPTION_MAX_LINES} lines the
 * remainder is dropped and the final line is ellipsised, so the block never
 * grows into the change-summary line or the next option.
 */

/** Number of lines the hold-full description area provides. */
export const CHOICE_DESCRIPTION_MAX_LINES = 2;

/**
 * Characters-per-line budget for 13 px monospace inside the 880 px
 * description wrap width. A monospace glyph advances roughly 7.8 px
 * (0.6 em), so 880 px holds about 112 characters; 108 leaves headroom for
 * font-metric differences while still fitting the longest catalogue
 * description (Teleport, 210 characters) on two lines.
 */
export const CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE = 108;

/** Rendered description area: the lines to draw plus the truncation flag. */
export interface WrappedDescription {
  /** Lines to render; never more than the requested `maxLines`. */
  readonly lines: string[];
  /** True when the copy needed more lines than the area provides. */
  readonly truncated: boolean;
}

/**
 * Splits a word that is longer than a whole line into line-sized chunks (a
 * single unbreakable token can never widen the text past the playfield).
 */
function splitLongWord(word: string, maxCharsPerLine: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < word.length; start += maxCharsPerLine) {
    chunks.push(word.slice(start, start + maxCharsPerLine));
  }
  return chunks;
}

/**
 * Greedily wraps `text` into lines of at most `maxCharsPerLine` characters
 * and keeps at most `maxLines` of them.
 *
 * Words are never broken unless a single word exceeds the line budget;
 * whitespace is collapsed to single spaces. When the wrapped copy needs more
 * than `maxLines` lines, the last kept line is trimmed to make room for a
 * trailing ellipsis and `truncated` is `true`.
 */
export function wrapChoiceDescription(
  text: string,
  maxCharsPerLine: number = CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
  maxLines: number = CHOICE_DESCRIPTION_MAX_LINES,
): WrappedDescription {
  if (maxCharsPerLine < 2) {
    throw new Error('maxCharsPerLine must be at least 2 to fit an ellipsis');
  }
  if (maxLines < 1) {
    throw new Error('maxLines must be at least 1');
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { lines: [], truncated: false };
  }

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const pieces =
      word.length > maxCharsPerLine
        ? splitLongWord(word, maxCharsPerLine)
        : [word];
    for (const piece of pieces) {
      if (current === '') {
        current = piece;
      } else if (current.length + 1 + piece.length <= maxCharsPerLine) {
        current += ` ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current !== '') lines.push(current);

  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }

  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1].slice(0, maxCharsPerLine - 1).trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, truncated: true };
}
