/**
 * Hermetic tests for the dev recording CLI shell
 * (AH-0MUY08W7Y004GATZ, AC1 + AC3).
 *
 * The CLIs are thin wrappers; these tests pin the argument parsing and run
 * selection that the browser/analysis logic depends on — including the
 * same-seed human+bot disambiguation and the null-seed regression where
 * `Number(null) === 0` must not be treated as a requested seed.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseAnalyseArgs, selectRun as selectAnalyseRun } from './analyse-recording.mjs';
import { parseReplayArgs, selectRun as selectReplayRun } from './replay-recording.mjs';
import { parseRecordArgs, recordUrl, resolveRecordingOutputPath } from './record-session.mjs';
import type { RecordingRun } from './recording.mjs';

function run(seed: number, index: number): RecordingRun {
  return {
    index,
    runSeed: seed,
    build: { appVersion: 't', commit: 't' },
    startedAt: null,
    ticks: [],
    events: [],
  };
}

describe('analyse-recording CLI', () => {
  it('parses the file, filters and flags', () => {
    expect(parseAnalyseArgs(['a.jsonl', '--json', '--seed', '7'])).toMatchObject({
      file: 'a.jsonl',
      json: true,
      seed: 7,
    });
  });

  it('defaults to the most recent run when no selector is given', () => {
    const runs = [run(1, 0), run(2, 1)];
    expect(selectAnalyseRun(runs, { runIndex: null, seed: null })).toBe(runs[1]);
  });

  it('selects by index then seed', () => {
    const runs = [run(1, 0), run(2, 1), run(2, 2)];
    expect(selectAnalyseRun(runs, { runIndex: 0, seed: null })).toBe(runs[0]);
    expect(selectAnalyseRun(runs, { runIndex: null, seed: 2 })).toBe(runs[1]);
  });
});

describe('replay-recording CLI', () => {
  it('parses flags and leaves selectors null', () => {
    expect(parseReplayArgs(['a.jsonl', '--list'])).toMatchObject({
      file: 'a.jsonl',
      list: true,
      seed: null,
      botFile: null,
      botSeed: null,
      tick: null,
    });
  });

  it('parses a separate bot recording file', () => {
    expect(parseReplayArgs(['human.jsonl', '--bot-file', 'bot.jsonl'])).toMatchObject({
      file: 'human.jsonl',
      botFile: 'bot.jsonl',
    });
  });

  it('disambiguates two same-seed runs when the bot selection excludes the human', () => {
    const human = run(99, 0);
    const bot = run(99, 1);
    const runs = [human, bot];
    expect(selectReplayRun(runs, null, 99)).toBe(human);
    expect(selectReplayRun(runs, null, 99, human)).toBe(bot);
  });

  it('falls back to the last run when neither index nor seed is given', () => {
    const runs = [run(1, 0), run(2, 1)];
    expect(selectReplayRun(runs, null, null)).toBe(runs[1]);
  });
});

describe('record-session CLI', () => {
  it('parses flags with headed human recording by default', () => {
    expect(parseRecordArgs([])).toMatchObject({ headed: true, bot: false, auto: false });
    expect(parseRecordArgs(['--bot', '--headless', '--seed', '42'])).toMatchObject({
      headed: false,
      bot: true,
      seed: 42,
    });
  });

  it('appends the dev seed to the game URL', () => {
    expect(recordUrl('http://localhost:5173/', { seed: 42 })).toBe('http://localhost:5173/?seed=42');
    expect(recordUrl('http://localhost:5173/?x=1', { seed: 42 })).toBe(
      'http://localhost:5173/?x=1&seed=42',
    );
    expect(recordUrl('http://localhost:5173/', { seed: null })).toBe('http://localhost:5173/');
  });

  it('resolves an output path, defaulting under recordings/', () => {
    expect(resolveRecordingOutputPath('/abs/out.jsonl', {})).toBe('/abs/out.jsonl');
    expect(resolveRecordingOutputPath('rel/out.jsonl', {})).toContain('rel/out.jsonl');
    expect(resolveRecordingOutputPath(null, { seed: 7 })).toMatch(/recordings[/\\]session-seed7-/);
    // A null seed (the CLI default) must not be coerced to `seed0`.
    expect(resolveRecordingOutputPath(null, { seed: null })).not.toContain('seed0');
  });
});

/**
 * Regression coverage for AH-0MV2RY8XT007I91E: each CLI entry point must
 * pass only `process.argv.slice(2)` to its `main`, so `argv[0]` (the node
 * binary path) is never treated as a flag or as the positional recording
 * file.  These tests exercise the real entry guards, not just the exported
 * parsers (which the suites above already cover).
 */
describe('CLI entry points (AH-0MV2RY8XT007I91E)', () => {
  const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
  const MINIMAL_RECORDING = [
    '{"kind":"run_header","schemaVersion":1,"runSeed":777,"build":{"appVersion":"test","commit":"abc"},"startedAt":1700000000000}',
    '{"kind":"tick","schemaVersion":1,"tick":0,"state":{},"input":{}}',
    '{"kind":"tick","schemaVersion":1,"tick":1,"state":{},"input":{}}',
  ].join('\n');

  const runCli = (script: string, args: string[], input?: string) =>
    spawnSync(process.execPath, [resolve(SCRIPTS_DIR, script), ...args], {
      input,
      encoding: 'utf8',
    });

  for (const script of ['record-session.mjs', 'analyse-recording.mjs', 'replay-recording.mjs']) {
    it(`${script} --help runs without treating argv[0] as an argument`, () => {
      const result = runCli(script, ['--help']);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Unknown argument');
      expect(result.stdout).toContain('Usage: node scripts/');
    });
  }

  it('analyse reads a piped recording rather than its own source', () => {
    // Before the fix, argv[0] became options.file, so stdin was ignored and
    // the script parsed its own source — reporting "No run found".
    const result = runCli('analyse-recording.mjs', ['--json'], MINIMAL_RECORDING);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"runSeed": 777');
    expect(result.stdout).not.toContain('No run found');
  });

  it('replay reads a piped recording rather than its own source', () => {
    const result = runCli('replay-recording.mjs', ['--list'], MINIMAL_RECORDING);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seed=777');
    expect(result.stdout).not.toContain('No runs in recording');
  });

  it('rejects a genuinely unknown flag without masking it as argv[0]', () => {
    const result = runCli('record-session.mjs', ['--definitely-not-a-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown argument: --definitely-not-a-flag');
  });
});
