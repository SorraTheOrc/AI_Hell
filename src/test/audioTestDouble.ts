/**
 * Reusable headless Web Audio test double (AH-0MUTYV8RJ009MWKJ).
 *
 * A recording `AudioContext` implementation used by the audio contract
 * tests. It records the nodes, gain automation events and scheduled start
 * times that the production cue code requests, so tests can assert the
 * playback contract without any real audio hardware.
 *
 * Extracted from `src/audio/effectsMaster.test.ts` so the master
 * volume/mute suite and the new cue-contract suite share one double.
 */

/** A single scheduled `AudioParam` automation event. */
export interface RecordedGainEvent {
  method:
    | 'setValueAtTime'
    | 'linearRampToValueAtTime'
    | 'exponentialRampToValueAtTime'
    | 'cancelScheduledValues';
  value: number;
  time: number;
}

/** A recorded gain node: its automation events, returned node and targets. */
export interface RecordedGain {
  gainEvents: RecordedGainEvent[];
  node?: unknown;
  connectTargets: unknown[];
}

/** A recorded oscillator / buffer source with its scheduled start/stop times. */
export interface RecordedSource {
  kind: 'oscillator' | 'bufferSource';
  type: string;
  starts: number[];
  stops: number[];
}

/**
 * Minimal recording `AudioContext` covering the surface used by
 * `src/audio/effects.ts`: oscillator, gain, buffer, buffer-source and
 * biquad-filter nodes, plus `currentTime`, `sampleRate` and `destination`.
 */
export class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];

  currentTime = 0;
  sampleRate = 44100;
  destination: unknown = {};

  oscillators: RecordedSource[] = [];
  gains: RecordedGain[] = [];
  /** Every target passed to `connect()` on this context's nodes. */
  connections: unknown[] = [];

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  private recordSource(kind: RecordedSource['kind'], type: string): RecordedSource {
    const rec: RecordedSource = { kind, type, starts: [], stops: [] };
    this.oscillators.push(rec);
    return rec;
  }

  createOscillator(): unknown {
    const rec = this.recordSource('oscillator', 'sine');
    const self = this;
    return {
      get type(): string {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: {
        setValueAtTime: (_value: number, _time: number) => {},
        exponentialRampToValueAtTime: (_value: number, _time: number) => {},
        linearRampToValueAtTime: (_value: number, _time: number) => {},
      },
      detune: { setValueAtTime: () => {} },
      connect: (target: unknown) => {
        self.connections.push(target);
        return {
          connect: (next: unknown) => {
            self.connections.push(next);
            return {};
          },
        };
      },
      start: (t: number) => {
        rec.starts.push(t);
      },
      stop: (t: number) => {
        rec.stops.push(t);
      },
    };
  }

  createGain(): unknown {
    const rec: RecordedGain = { gainEvents: [], connectTargets: [] };
    const self = this;
    this.gains.push(rec);
    const node = {
      context: self,
      gain: {
        setValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'setValueAtTime', value, time });
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'linearRampToValueAtTime', value, time });
        },
        exponentialRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'exponentialRampToValueAtTime', value, time });
        },
        cancelScheduledValues: (time: number) => {
          rec.gainEvents.push({ method: 'cancelScheduledValues', value: -1, time });
        },
      },
      connect: (target: unknown) => {
        rec.connectTargets.push(target);
        self.connections.push(target);
        return {};
      },
    };
    rec.node = node;
    return node;
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): unknown {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return { getChannelData: () => data };
  }

  createBufferSource(): unknown {
    const rec = this.recordSource('bufferSource', 'noise');
    const self = this;
    return {
      buffer: null as unknown,
      loop: false,
      connect: (target: unknown) => {
        self.connections.push(target);
        return {
          connect: (next: unknown) => {
            self.connections.push(next);
            return {};
          },
        };
      },
      start: (t: number) => {
        rec.starts.push(t);
      },
      stop: (t: number) => {
        rec.stops.push(t);
      },
    };
  }

  createBiquadFilter(): unknown {
    const self = this;
    return {
      type: 'lowpass' as const,
      frequency: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
      Q: { setValueAtTime: () => {} },
      connect: (target: unknown) => {
        self.connections.push(target);
        return {};
      },
    };
  }
}

/** The most recent recording context, or `undefined` when none was created. */
export function latestRecordingContext(): RecordingAudioContext | undefined {
  return RecordingAudioContext.instances[RecordingAudioContext.instances.length - 1];
}

/** The most recently created gain node (the master SFX gain is created first). */
export function latestGain(): RecordedGain | undefined {
  const ctx = latestRecordingContext();
  return ctx?.gains[ctx.gains.length - 1];
}

/** The master SFX gain of the first context (the first gain created there). */
export function masterGain(): RecordedGain | undefined {
  return RecordingAudioContext.instances[0]?.gains[0];
}

/** The most recent non-automation gain value scheduled on *gain*. */
export function lastGainValue(gain: RecordedGain): number | undefined {
  for (const ev of [...gain.gainEvents].reverse()) {
    if (ev.method === 'setValueAtTime' || ev.method === 'linearRampToValueAtTime') {
      return ev.value;
    }
  }
  return undefined;
}

/** Clears recorded instances/events without touching the module cache. */
export function resetRecordingAudioContext(): void {
  RecordingAudioContext.instances.length = 0;
}
