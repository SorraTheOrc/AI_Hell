/**
 * Side-by-side capture-plan tests for the evaluation harness
 * (AH-0MUY08XLD009K4W4, AC4).
 *
 * The plan is pure data; these assert the commands it builds rather than
 * executing a browser or ffmpeg.
 */

import { describe, expect, it } from 'vitest';

import { buildSideBySideCapturePlan } from './video';

describe('buildSideBySideCapturePlan (AC4)', () => {
  it('builds a bot capture command and an hstack compose command', () => {
    const plan = buildSideBySideCapturePlan({
      outputDir: 'eval-output',
      humanVideo: 'recordings/human.webm',
    });
    expect(plan.botCaptureCommand).toContain('scripts/capture-gameplay.mjs');
    expect(plan.botVideo).toBe('eval-output/bot.webm');
    expect(plan.humanVideo).toBe('recordings/human.webm');
    expect(plan.composeCommand).toContain('ffmpeg');
    expect(plan.composeCommand).toContain('hstack=inputs=2');
    expect(plan.composeCommand).toContain('scale=960:540');
    expect(plan.composeCommand).toContain('recordings/human.webm');
    expect(plan.composeCommand).toContain('-r 60');
    expect(plan.composeCommand).toContain('eval-output/side-by-side.mp4');
  });

  it('leaves a placeholder and a note when no human clip is supplied', () => {
    const plan = buildSideBySideCapturePlan({ outputDir: 'out' });
    expect(plan.humanVideo).toBeNull();
    expect(plan.composeCommand).toContain('<human.webm>');
    expect(plan.notes.some((note) => note.includes('placeholder'))).toBe(true);
  });

  it('honours panel size and frame rate overrides', () => {
    const plan = buildSideBySideCapturePlan({
      outputDir: 'out/',
      humanVideo: 'h.webm',
      width: 480,
      height: 270,
      fps: 30,
    });
    expect(plan.botVideo).toBe('out/bot.webm');
    expect(plan.composeCommand).toContain('scale=480:270');
    expect(plan.composeCommand).toContain('-r 30');
  });
});
