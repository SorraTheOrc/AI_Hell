/**
 * `.otio` document writer tests for the intensity-arc promo (AH-0MWPD4U3M003YG5M).
 *
 * The writer is pure: a plan in, a `Timeline.1` document and its canonical
 * bytes out. Everything here is asserted against the schema `vidc` reads
 * (`video_compiler` `src/otio/model.ts`) and against the planner's own config
 * and totals, so the document can never record values the plan did not use.
 *
 * No browser, no network, no footage: the plans come from synthetic captures
 * built through the canonical serialisers. The end-to-end `vidc timeline` /
 * `vidc render` acceptance is a documented manual step on the work item (the
 * binary is not available in this environment).
 *
 * Naming note: this file keeps every DOM-global-looking identifier out of its
 * *code* (the plan's segments are `cut`), because `vitest.projects.ts`
 * classifies a file as `integration` when its code mentions one — and this is a
 * pure-Node `unit` suite.
 */

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_RUN_STARTED_AT_EPOCH_MS,
  buildFixtureAnchor,
  serialiseCaptureAnchor,
  serialisePlateauSeries,
} from './intensity-arc-fixtures.mjs';
import {
  DEFAULT_INTENSITY_ARC_CONFIG,
  loadIntensityCorpus,
  planIntensityArc,
  planTotals,
} from './intensity-arc.mjs';
import type {
  IntensityArcCapture,
  IntensityArcConfig,
  IntensityArcPlanWindow,
} from './intensity-arc.mjs';
import {
  DEFAULT_OTIO_RATE,
  OTIO_GENERATOR,
  OTIO_SCHEMA_LABELS,
  OTIO_SCHEMA_VERSION,
  OtioWriteError,
  buildOtioDocument,
  defaultClipFileName,
  durationToFrames,
  isMediaBasename,
  renderOtioDocument,
  serialiseOtioDocument,
  startToFrames,
} from './otio-write.mjs';
import type {
  OtioClip,
  OtioTimelineDocument,
  OtioTransition,
} from './otio-write.mjs';

/** One half-open, constant-intensity stretch of a synthetic series. */
type Plateau = { fromT: number; toT: number; intensity: number };

/** One plateau per band, each comfortably above its 7/7/10/10 s target. */
const FULL_ARC_PLATEAUS: Plateau[] = [
  { fromT: 0, toT: 8000, intensity: 0.46 },
  { fromT: 8000, toT: 16000, intensity: 0.6 },
  { fromT: 16000, toT: 27000, intensity: 0.7 },
  { fromT: 27000, toT: 38000, intensity: 0.82 },
];

/**
 * A zero-join-offset synthetic corpus (see `intensity-arc.test.ts` for why the
 * committed fixtures' capture-start offset makes them arc-unsatisfiable).
 */
function syntheticCorpus(
  specs: ReadonlyArray<{ stem: string; plateaus: Plateau[] }>,
): IntensityArcCapture[] {
  const files = new Map<string, string>();
  for (const spec of specs) {
    files.set(`${spec.stem}.action.jsonl`, serialisePlateauSeries(spec.plateaus));
    files.set(
      `${spec.stem}.capture.json`,
      serialiseCaptureAnchor(
        buildFixtureAnchor({
          runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
          captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
        }),
      ),
    );
  }
  const { captures } = loadIntensityCorpus(
    specs.map((spec) => spec.stem),
    {
      readFile: (fileName) => {
        const text = files.get(fileName);
        if (text === undefined) throw new Error(`synthetic corpus has no ${fileName}`);
        return text;
      },
      warn: () => {},
    },
  );
  return captures;
}

/** The single-capture plan every shape test starts from. */
function plannedArc(): IntensityArcPlanWindow[] {
  return planIntensityArc(syntheticCorpus([{ stem: 'clip-a', plateaus: FULL_ARC_PLATEAUS }]));
}

/** Every clip in the document, in track order. */
function clipsOf(document: OtioTimelineDocument): OtioClip[] {
  return document.tracks.children.flatMap((track) =>
    track.children.filter((child): child is OtioClip => child.OTIO_SCHEMA === OTIO_SCHEMA_LABELS.clip),
  );
}

/** Every transition in the document, in track order. */
function transitionsOf(document: OtioTimelineDocument): OtioTransition[] {
  return document.tracks.children.flatMap((track) =>
    track.children.filter(
      (child): child is OtioTransition => child.OTIO_SCHEMA === OTIO_SCHEMA_LABELS.transition,
    ),
  );
}

describe('.otio writer — schema pin and labels (AH-0MWPD4U3M003YG5M)', () => {
  it('mirrors the OpenTimelineIO 0.16.0 labels and the vidc default rate', () => {
    expect(OTIO_SCHEMA_VERSION).toBe('0.16.0');
    expect(DEFAULT_OTIO_RATE).toBe(30);
    expect(OTIO_SCHEMA_LABELS).toEqual({
      timeline: 'Timeline.1',
      stack: 'Stack.1',
      track: 'Track.1',
      clip: 'Clip.1',
      transition: 'Transition.1',
      timeRange: 'TimeRange.1',
      rationalTime: 'RationalTime.1',
      externalReference: 'ExternalReference.1',
    });
  });

  it('records the schema pin, generator and clip count in the project block', () => {
    const plan = plannedArc();
    const document = buildOtioDocument(plan);
    expect(document.metadata.vidc.otio_schema_version).toBe(OTIO_SCHEMA_VERSION);
    expect(document.metadata.vidc.generator).toBe(OTIO_GENERATOR);
    expect(document.metadata.vidc.clip_count).toBe(plan.length);
    // The pin is the first key of the block, matching video_compiler's writer.
    expect(Object.keys(document.metadata.vidc)[0]).toBe('otio_schema_version');
  });
});

describe('.otio writer — document shape (AH-0MWPD4U3M003YG5M)', () => {
  it('emits a Timeline.1 / Stack.1 / Track.1 / Clip.1 document with one video track', () => {
    const plan = plannedArc();
    const document = buildOtioDocument(plan);

    expect(document.OTIO_SCHEMA).toBe(OTIO_SCHEMA_LABELS.timeline);
    expect(document.global_start_time).toBeNull();
    expect(document.tracks.OTIO_SCHEMA).toBe(OTIO_SCHEMA_LABELS.stack);
    expect(document.tracks.children).toHaveLength(1);
    const track = document.tracks.children[0]!;
    expect(track.OTIO_SCHEMA).toBe(OTIO_SCHEMA_LABELS.track);
    expect(track.kind).toBe('Video');
    expect(track.enabled).toBe(true);
    // One clip per window, in arc order, each followed by a zero-length Cut.
    const clips = clipsOf(document);
    expect(
      clips.map((clip) => (clip.metadata.vidc as { intensity_band?: string } | undefined)?.intensity_band),
    ).toEqual(plan.map((cut) => cut.band));
    expect(clips).toHaveLength(plan.length);
    const cuts = transitionsOf(document);
    expect(cuts).toHaveLength(plan.length);
    for (const transition of cuts) {
      expect(transition).toMatchObject({ transition_type: 'Cut', enabled: true });
      expect(transition.in_offset).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 30, value: 0 });
      expect(transition.out_offset).toEqual({ OTIO_SCHEMA: 'RationalTime.1', rate: 30, value: 0 });
    }
  });

  it('carries one clip per window with the planned in point and duration in frames', () => {
    const plan = plannedArc();
    const document = buildOtioDocument(plan);
    const clips = clipsOf(document);

    for (const [index, cut] of plan.entries()) {
      const range = clips[index]!.source_range;
      expect(range.OTIO_SCHEMA).toBe(OTIO_SCHEMA_LABELS.timeRange);
      expect(range.start_time.OTIO_SCHEMA).toBe(OTIO_SCHEMA_LABELS.rationalTime);
      expect(range.start_time.rate).toBe(30);
      expect(range.duration.rate).toBe(30);
      expect(range.start_time.value).toBe(Math.round(cut.inSeconds * 30));
      expect(range.duration.value).toBe(Math.round(cut.durationSeconds * 30));
      // Mirrored as the available range: the whole window is available.
      expect(clips[index]!.media_reference.available_range).toEqual(range);
      expect(clips[index]!.active_media_reference_key).toBe('DEFAULT_MEDIA');
    }
  });

  it('quantises every cut point to within one frame of the planned window', () => {
    const plan = plannedArc();
    const clips = clipsOf(buildOtioDocument(plan));
    const frame = 1 / DEFAULT_OTIO_RATE;

    for (const [index, cut] of plan.entries()) {
      const range = clips[index]!.source_range;
      const startSeconds = range.start_time.value / range.start_time.rate;
      const durationSeconds = range.duration.value / range.duration.rate;
      // Half a frame of rounding each, documented on durationToFrames: the
      // ±100 ms per-band acceptance tolerance stays reachable.
      expect(Math.abs(startSeconds - cut.inSeconds)).toBeLessThanOrEqual(frame / 2 + 1e-9);
      expect(Math.abs(durationSeconds - cut.durationSeconds)).toBeLessThanOrEqual(frame / 2 + 1e-9);
      // ...and the clip is never empty.
      expect(range.duration.value).toBeGreaterThanOrEqual(1);
    }

    expect(durationToFrames(7.225, 30)).toBe(217);
    expect(durationToFrames(0, 30)).toBe(1);
    expect(startToFrames(16, 30)).toBe(480);
    expect(startToFrames(0, 30)).toBe(0);
  });
});

describe('.otio writer — document-relative media (AH-0MWPD4U3M003YG5M)', () => {
  it('names every target_url as a bare basename', () => {
    const plan = plannedArc();
    const clips = clipsOf(buildOtioDocument(plan));

    for (const [index, clip] of clips.entries()) {
      expect(clip.media_reference.target_url).toBe(`${plan[index]!.sourceStem}.webm`);
      expect(isMediaBasename(clip.media_reference.target_url)).toBe(true);
      expect(clip.media_reference.target_url).not.toMatch(/[/\\:]/);
      expect(clip.name).toBe(clip.media_reference.target_url);
    }
    expect(defaultClipFileName(plan[0]!)).toBe(`${plan[0]!.sourceStem}.webm`);
  });

  it('spans two captures with one basename each when the plan is pooled', () => {
    const captures = syntheticCorpus([
      {
        stem: 'gameplay-2',
        plateaus: [
          { fromT: 0, toT: 4000, intensity: 0.46 },
          { fromT: 4000, toT: 15000, intensity: 0.7 },
        ],
      },
      {
        stem: 'gameplay-10',
        plateaus: [
          { fromT: 0, toT: 5000, intensity: 0.46 },
          { fromT: 5000, toT: 13000, intensity: 0.6 },
          { fromT: 13000, toT: 24000, intensity: 0.82 },
        ],
      },
    ]);
    const plan = planIntensityArc(captures);
    const clips = clipsOf(buildOtioDocument(plan));

    const urls = clips.map((clip) => clip.media_reference.target_url);
    expect(new Set(urls)).toEqual(new Set(['gameplay-2.webm', 'gameplay-10.webm']));
    for (const url of urls) expect(isMediaBasename(url)).toBe(true);
  });

  it('rejects a target_url with a path component instead of silently mangling it', () => {
    const plan = plannedArc();
    expect(() =>
      buildOtioDocument(plan, { clipFileName: (cut) => `capture-output/${cut.sourceStem}.webm` }),
    ).toThrow(OtioWriteError);
    expect(() =>
      buildOtioDocument(plan, { clipFileName: (cut) => `/abs/${cut.sourceStem}.webm` }),
    ).toThrow(/bare basename/);
    expect(isMediaBasename('capture-output/a.webm')).toBe(false);
    expect(isMediaBasename('/abs/a.webm')).toBe(false);
    expect(isMediaBasename('..')).toBe(false);
    expect(isMediaBasename('')).toBe(false);
  });
});

describe('.otio writer — auditable planner metadata (AH-0MWPD4U3M003YG5M)', () => {
  it('echoes the planner config object exactly', () => {
    const plan = plannedArc();
    const arc = buildOtioDocument(plan).metadata.vidc.intensity_arc;
    const config = DEFAULT_INTENSITY_ARC_CONFIG;

    expect(arc.bands).toEqual(
      config.bands.map((band) => ({
        name: band.name,
        min: band.min,
        max: band.max,
        target_seconds: band.targetSeconds,
      })),
    );
    expect(arc.min_window_seconds).toBe(config.minWindowSeconds);
    expect(arc.fade_seconds).toBe(config.fadeSeconds);
    expect(arc.sample_rate_hz).toBe(config.sampleRateHz);
    expect(arc.edge_nudge_seconds).toBe(config.edgeNudgeSeconds);
  });

  it('records the plan totals the planner computed, per band and overall', () => {
    const plan = plannedArc();
    const arc = buildOtioDocument(plan).metadata.vidc.intensity_arc;
    const totals = planTotals(plan);

    expect(arc.achieved_seconds).toEqual(totals.byBand);
    expect(arc.footage_seconds).toBeCloseTo(totals.footageSeconds, 9);
    expect(arc.fade_overlap_seconds).toBeCloseTo(totals.fadeSeconds, 9);
    expect(arc.rendered_seconds).toBeCloseTo(totals.renderedSeconds, 9);
    expect(arc.windows).toEqual(
      plan.map((cut) => ({
        band: cut.band,
        source_stem: cut.sourceStem,
        in_seconds: cut.inSeconds,
        duration_seconds: cut.durationSeconds,
      })),
    );
  });

  it('records a retuned config, never the default', () => {
    const plan = plannedArc();
    const config: IntensityArcConfig = { ...DEFAULT_INTENSITY_ARC_CONFIG, fadeSeconds: 0.5 };
    const arc = buildOtioDocument(plan, { config }).metadata.vidc.intensity_arc;

    expect(arc.fade_seconds).toBe(0.5);
    expect(arc.achieved_seconds).toEqual(planTotals(plan, config).byBand);
  });
});

describe('.otio writer — byte-stable serialisation (AH-0MWPD4U3M003YG5M)', () => {
  it('serialises the same plan to byte-identical text on a double run', () => {
    const first = renderOtioDocument(plannedArc());
    const second = renderOtioDocument(plannedArc());
    expect(second.text).toBe(first.text);
    // ...and from a re-planned corpus built independently, too.
    expect(renderOtioDocument(planIntensityArc(syntheticCorpus([
      { stem: 'clip-a', plateaus: FULL_ARC_PLATEAUS },
    ]))).text).toBe(first.text);
  });

  it('writes two-space indented JSON with one trailing newline', () => {
    const { text } = renderOtioDocument(plannedArc());
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).toMatch(/^\{\n {2}"OTIO_SCHEMA": "Timeline\.1",\n/);
    // The text round-trips through JSON.parse to the same document.
    expect(JSON.parse(text)).toEqual(renderOtioDocument(plannedArc()).document);
  });

  it('refuses a document whose root is not a Timeline.1 object', () => {
    expect(() =>
      serialiseOtioDocument({ OTIO_SCHEMA: 'Clip.1' } as unknown as OtioTimelineDocument),
    ).toThrow(OtioWriteError);
    expect(() => serialiseOtioDocument(null as unknown as OtioTimelineDocument)).toThrow(
      OtioWriteError,
    );
  });

  it('rejects a non-finite duration or in point rather than emitting null', () => {
    expect(() => durationToFrames(Number.NaN)).toThrow(OtioWriteError);
    expect(() => startToFrames(Number.POSITIVE_INFINITY)).toThrow(OtioWriteError);
  });

  it('builds an empty document for an empty plan', () => {
    const document = buildOtioDocument([]);
    expect(clipsOf(document)).toEqual([]);
    expect(transitionsOf(document)).toEqual([]);
    expect(document.metadata.vidc.clip_count).toBe(0);
    expect(document.metadata.vidc.intensity_arc.rendered_seconds).toBe(0);
    expect(serialiseOtioDocument(document)).toMatch(/"children": \[\]/);
  });
});
