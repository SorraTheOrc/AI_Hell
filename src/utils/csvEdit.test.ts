/**
 * Declarative single-field CSV edit tests (AH-0MVBNISWE009QFBL, child 3 of
 * AH-0MV8Q5EYE001R715).
 *
 * Test-first suite for `src/util/csvEdit.ts`: the pure `--set` assignment
 * parser, the quote-aware single-field editor (`applyCsvEdit`), the known-
 * file guard and deterministic behaviour. The shell-level capture/restore
 * helpers are covered in `scripts/csvEdit-shell.test.ts` (success and
 * failure paths, byte-identical restore, the `--keep-edit` opt-out).
 */

import { describe, expect, it } from 'vitest';

import {
  CsvEditError,
  KNOWN_BALANCE_CSV_FILES,
  applyCsvEdit,
  parseAssignment,
  parseEditSpec,
} from './csvEdit';

/** Minimal enemy-config-style fixture with a comment block. */
const ENEMY_FIXTURE = [
  '# Enemy Configurations CSV',
  '# One row per enemy archetype.',
  'key,displayName,size,health',
  'scout,Scout,16,1',
  'boss,Boss Swarm,50,1',
].join('\n');

describe('parseAssignment (--set <file> <assignment>)', () => {
  it('parses a row-keyed assignment `boss.health=6`', () => {
    expect(parseAssignment('boss.health=6')).toEqual({
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
  });

  it('parses a single-row assignment `thrustAcceleration=320` (no row key)', () => {
    expect(parseAssignment('thrustAcceleration=320')).toEqual({
      rowKey: null,
      field: 'thrustAcceleration',
      value: '320',
    });
  });

  it('keeps non-numeric values verbatim (`generation=curve`)', () => {
    expect(parseAssignment('5.generation=curve')).toEqual({
      rowKey: '5',
      field: 'generation',
      value: 'curve',
    });
  });

  it('rejects a malformed assignment (no "=")', () => {
    expect(() => parseAssignment('boss.health')).toThrow(CsvEditError);
  });

  it('rejects an assignment with an empty field name', () => {
    expect(() => parseAssignment('.=6')).toThrow(CsvEditError);
  });

  it('rejects an assignment with an empty value', () => {
    expect(() => parseAssignment('boss.health=')).toThrow(CsvEditError);
  });

  it('rejects an empty assignment string', () => {
    expect(() => parseAssignment('')).toThrow(CsvEditError);
  });
});

describe('parseEditSpec (file + assignment)', () => {
  it('combines a known file with an assignment', () => {
    expect(parseEditSpec('enemy-configs.csv', 'boss.health=6')).toEqual({
      file: 'enemy-configs.csv',
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
  });

  it('accepts every declared balance CSV', () => {
    for (const file of KNOWN_BALANCE_CSV_FILES) {
      expect(() => parseEditSpec(file, 'x=1')).not.toThrow();
    }
  });

  it('refuses an unknown file', () => {
    expect(() => parseEditSpec('secrets.csv', 'x=1')).toThrow(
      /not a supported balance CSV|unknown/i,
    );
  });
});

describe('applyCsvEdit — one single-field edit (AC1)', () => {
  it('edits exactly one field of one row and records previous/new values', () => {
    const outcome = applyCsvEdit(ENEMY_FIXTURE, {
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
    expect(outcome.changed).toBe(true);
    expect(outcome.previousValue).toBe('1');
    expect(outcome.newValue).toBe('6');
    expect(outcome.csv).toContain('boss,Boss Swarm,50,6');
    expect(outcome.csv).toContain('scout,Scout,16,1');
    expect(outcome.csv).toContain('# Enemy Configurations CSV');
  });

  it('leaves every other row byte-identical', () => {
    const outcome = applyCsvEdit(ENEMY_FIXTURE, {
      rowKey: 'scout',
      field: 'size',
      value: '20',
    });
    expect(outcome.csv).toContain('scout,Scout,20,1');
    expect(outcome.csv).toContain('boss,Boss Swarm,50,1');
  });

  it('edits the single data row when no row key is given', () => {
    const shipFixture = ['thrustAcceleration,maxSpeed', '300,175'].join('\n');
    const outcome = applyCsvEdit(shipFixture, {
      rowKey: null,
      field: 'thrustAcceleration',
      value: '320',
    });
    expect(outcome.previousValue).toBe('300');
    expect(outcome.csv).toContain('320,175');
  });

  it('treats an identical value as a no-op edit (changed = false)', () => {
    const outcome = applyCsvEdit(ENEMY_FIXTURE, {
      rowKey: 'boss',
      field: 'health',
      value: '1',
    });
    expect(outcome.changed).toBe(false);
    expect(outcome.previousValue).toBe('1');
    expect(outcome.csv).toBe(ENEMY_FIXTURE);
  });

  it('is deterministic: same input yields byte-identical output', () => {
    const spec = { rowKey: 'boss', field: 'health', value: '6' };
    expect(applyCsvEdit(ENEMY_FIXTURE, spec).csv).toBe(
      applyCsvEdit(ENEMY_FIXTURE, spec).csv,
    );
  });
});

describe('applyCsvEdit — quoted-field safety', () => {
  it('splices a later field correctly when an earlier field is quoted', () => {
    const fixture = [
      'key,displayName,size,health',
      'scout,"Scout, elite",16,1',
      'boss,"Boss Swarm",50,7',
    ].join('\n');
    const outcome = applyCsvEdit(fixture, {
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
    expect(outcome.previousValue).toBe('7');
    expect(outcome.csv).toContain('boss,"Boss Swarm",50,6');
    expect(outcome.csv).toContain('scout,"Scout, elite",16,1');
  });

  it('splices a quoted target field and unquotes the previous value', () => {
    const fixture = ['key,displayName,size,health', 'boss,"Boss",50,"7"'].join(
      '\n',
    );
    const outcome = applyCsvEdit(fixture, {
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
    expect(outcome.previousValue).toBe('7');
    expect(outcome.csv).toContain('boss,"Boss",50,6');
  });

  it('quotes a new value containing a comma', () => {
    const fixture = ['key,displayName', 'boss,Plain'].join('\n');
    const outcome = applyCsvEdit(fixture, {
      rowKey: 'boss',
      field: 'displayName',
      value: 'Boss, Big',
    });
    expect(outcome.csv).toContain('boss,"Boss, Big"');
  });
});

describe('applyCsvEdit — CRLF and error handling', () => {
  it('preserves CRLF line endings on the edited file', () => {
    const fixture = ENEMY_FIXTURE.replaceAll('\n', '\r\n');
    const outcome = applyCsvEdit(fixture, {
      rowKey: 'boss',
      field: 'health',
      value: '6',
    });
    expect(outcome.csv).toContain('boss,Boss Swarm,50,6');
    // CRLF is preserved: every newline is preceded by a carriage return, and
    // the edited line count matches the original.
    expect(outcome.csv).not.toMatch(/(^|[^\r])\n/);
    expect(outcome.csv.split('\r\n').length).toBe(fixture.split('\r\n').length);
  });

  it('errors with a structured code when the field is not in the header', () => {
    expect(() =>
      applyCsvEdit(ENEMY_FIXTURE, { rowKey: 'boss', field: 'nope', value: '6' }),
    ).toThrow(CsvEditError);
    expect(() =>
      applyCsvEdit(ENEMY_FIXTURE, { rowKey: 'boss', field: 'nope', value: '6' }),
    ).toThrow(/column/i);
  });

  it('errors when the row key is absent from the data rows', () => {
    expect(() =>
      applyCsvEdit(ENEMY_FIXTURE, { rowKey: 'grue', field: 'health', value: '6' }),
    ).toThrow(/row/i);
  });

  it('errors when the file has no data row to edit', () => {
    expect(() =>
      applyCsvEdit('# only comments\n', { rowKey: null, field: 'health', value: '6' }),
    ).toThrow(/header|data row/i);
  });
});
