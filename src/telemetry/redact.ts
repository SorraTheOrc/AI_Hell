/**
 * PII / secret redaction and JSON-safety for telemetry payloads
 * (AH-0MUY08VJ9006BHJO, AC5).
 *
 * Telemetry must never carry personally identifiable information (PII) or
 * credentials. Two defences apply:
 *
 * 1. **By design** — the schema records positional/numeric gameplay state and
 *    input only; the instrumentation layer never records a player's real
 *    name, email or account details (see `docs/TELEMETRY.md`).
 * 2. **Defence in depth** — every payload is passed through
 *    {@link sanitiseTelemetryValue} at the recorder boundary, so a mistaken
 *    call site cannot leak a sensitive field: keys that look like PII or
 *    secrets are replaced with `'[redacted]'`, email-like strings are
 *    masked, and the result is guaranteed to be plain JSON (no `undefined`,
 *    functions, class instances or cycles).
 *
 * ## Cost (AH-0MW2DC20A007TAVY)
 *
 * Redaction runs on every recorded tick, over a state vector that can hold
 * thousands of entity entries, so the per-key and per-string decisions are
 * memoised ({@link isSensitiveTelemetryKey}, the email scan) behind bounded
 * caches. The outputs are unchanged — the cache only avoids repeating a
 * decision the same input has already been given.
 *
 * @module src/telemetry/redact
 */

import type { TelemetryJson } from './schema';

/** Marker substituted for a sensitive field's value. */
export const TELEMETRY_REDACTED = '[redacted]';

/** Marker substituted for an email-like substring inside a string value. */
export const TELEMETRY_REDACTED_EMAIL = '[redacted:email]';

/**
 * Key names (matched case-insensitively as substrings) whose values are
 * redacted. Kept deliberately broad — over-redacting a harmless field is
 * preferable to leaking one — but avoids short words like `pass`/`key` that
 * would match legitimate fields such as `passed` or `hotkey`.
 */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|passphrase|passcode|secret|token|api[_-]?key|apikey|authorization|cookie|credential|csrf|email|e[_-]?mail|phone|mobile|address|postcode|zip[_-]?code|ssn|social[_-]?security|passport|credit[_-]?card|card[_-]?number|cvv|username|user[_-]?id|display[_-]?name|real[_-]?name|full[_-]?name|first[_-]?name|last[_-]?name)/i;

/** Addresses that look like an email, masked inside string values. */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/**
 * True when a payload key names a field that must not be recorded.
 *
 * Memoised (AH-0MW2DC20A007TAVY): a recorded tick repeats the same handful of
 * schema keys (`x`, `y`, `vx`, `vy`, `alive`, `archetype`, …) thousands of
 * times per second, so the verdict is cached per key name. The cache is an
 * implementation detail of this same function — every answer is identical to
 * the regex test it replaces — and it is bounded, so an arbitrary payload can
 * never grow it without limit.
 *
 * @param key - The object key to test.
 */
export function isSensitiveTelemetryKey(key: string): boolean {
  const cached = keyVerdicts.get(key);
  if (cached !== undefined) return cached;
  const verdict = SENSITIVE_KEY_PATTERN.test(key);
  remember(keyVerdicts, key, verdict);
  return verdict;
}

/**
 * Converts an arbitrary value into a JSON-safe, PII-free
 * {@link TelemetryJson} tree.
 *
 * - Sensitive keys are replaced with {@link TELEMETRY_REDACTED}.
 * - Email-like substrings are replaced with {@link TELEMETRY_REDACTED_EMAIL}.
 * - Non-finite numbers become `null`; `undefined`, functions, symbols and
 *   non-plain class instances become `null`; `bigint` becomes a string.
 * - `Date` values become ISO strings.
 * - Cycles are broken with `'[circular]'` rather than throwing.
 *
 * The input is never mutated — a fresh tree is returned.
 *
 * @param value - Any value a call site wants to record.
 */
export function sanitiseTelemetryValue(value: unknown): TelemetryJson {
  return sanitise(value, new WeakSet<object>());
}

/** Recursive worker; `seen` tracks ancestors to break cycles. */
function sanitise(value: unknown, seen: WeakSet<object>): TelemetryJson {
  if (value === null) return null;

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return typeof value === 'string' ? redactEmails(value) : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
    case 'object':
      return sanitiseObject(value, seen);
    default:
      return null;
  }
}

/** Sanitises an object/array value, guarding against cycles. */
function sanitiseObject(value: object, seen: WeakSet<object>): TelemetryJson {
  if (seen.has(value)) return '[circular]';

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    const result = value.map((entry) => sanitise(entry, seen));
    seen.delete(value);
    return result;
  }

  if (!isPlainObject(value)) return null;

  seen.add(value);
  const result: { [key: string]: TelemetryJson } = {};
  for (const key of Object.keys(value)) {
    result[key] = isSensitiveTelemetryKey(key)
      ? TELEMETRY_REDACTED
      : sanitise((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

/** True for object literals and `Object.create(null)` maps only. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Replaces email-like substrings in a string with the email marker. */
function redactEmails(value: string): string {
  // The overwhelmingly common case is a value with no `@` at all (an
  // archetype name, an id, a scheme tag): the scan cannot match, so it never
  // runs. This is memoised like the key verdict — telemetry strings repeat
  // heavily within a run (AH-0MW2DC20A007TAVY).
  if (!value.includes('@')) return value;
  const cached = valueRedactions.get(value);
  if (cached !== undefined) return cached;
  const redacted = value.replace(EMAIL_PATTERN, TELEMETRY_REDACTED_EMAIL);
  remember(valueRedactions, value, redacted);
  return redacted;
}

/**
 * Ceiling on each memoised redaction cache (AH-0MW2DC20A007TAVY).
 *
 * A run's payload repeats a small closed set of keys and string values, so the
 * caches reach a steady state of a few dozen entries. The ceiling only bounds
 * a pathological caller (arbitrary, never-repeating keys/strings): crossing it
 * clears the cache rather than evicting one entry, which costs a re-test but
 * keeps both lookup and memory strictly bounded.
 */
export const REDACTION_CACHE_LIMIT = 4096;

/** Memoised key verdicts (`true` = sensitive). */
const keyVerdicts = new Map<string, boolean>();

/** Memoised email-redacted string values. */
const valueRedactions = new Map<string, string>();

/** Stores a memo entry, clearing the cache first when it is at its bound. */
function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= REDACTION_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
}

/**
 * Current entry counts of both redaction caches (diagnostics and the
 * bounded-growth test). Exposed as a snapshot so callers cannot mutate them.
 */
export function redactionCacheSizes(): { readonly keys: number; readonly values: number } {
  return { keys: keyVerdicts.size, values: valueRedactions.size };
}

/** Empties both redaction caches (tests and diagnostics only). */
export function clearRedactionCaches(): void {
  keyVerdicts.clear();
  valueRedactions.clear();
}
