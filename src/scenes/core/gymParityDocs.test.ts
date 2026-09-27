import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Docs guard for the gym-parity principle (AH-0MUGZDTFX004RBD1, AC4).
 *
 * The producer directive is that gyms are the canonical parity reference for
 * the game, and that any gameplay behaviour change must be applied
 * consistently to the corresponding gym scene(s) and the game unless a
 * documented reason exists to diverge. `AGENTS.md` must state that rule
 * explicitly and name the files it covers, so a reader knows exactly which
 * scenes are in scope.
 *
 * This is the automated grep required by AC4: it fails if the rule text or the
 * named gym/game directories are removed or weakened. It asserts the evidence
 * inside the named section rather than anywhere in the file, so an unrelated
 * mention of a gym cannot satisfy the guard.
 */
const AGENTS_MD = path.resolve(process.cwd(), 'AGENTS.md');
const GYM_PARITY_SECTION = '## Game Architecture Conventions';

/** Return the body of `heading` up to the next level-2 heading (or EOF). */
function sectionBody(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) return '';
  const rest = source.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('AGENTS.md documents the gym-parity principle (AH-0MUGZDTFX004RBD1)', () => {
  const source = fs.readFileSync(AGENTS_MD, 'utf8');
  // Collapse prose line-wrapping so assertions match the rule text, not the
  // markdown wrapping.
  const rule = sectionBody(source, GYM_PARITY_SECTION).replace(/\s+/g, ' ');

  it('has a Game Architecture Conventions section (AC1)', () => {
    expect(source).toContain(GYM_PARITY_SECTION);
    expect(rule.trim().length).toBeGreaterThan(0);
  });

  it('states gyms are the canonical parity reference for the game (AC1)', () => {
    expect(rule).toMatch(/gyms are the canonical parity reference/i);
  });

  it('requires gameplay changes to apply to the corresponding gym scene(s) and the game (AC1)', () => {
    expect(rule).toMatch(/applied consistently/i);
    expect(rule).toMatch(/gym scene\(s\) and the game/i);
  });

  it('allows divergence only with a documented reason (AC1)', () => {
    expect(rule).toMatch(/documented reason/i);
    expect(rule).toMatch(/to diverge/i);
  });

  it('names the gym scene directory and its generic base (AC2)', () => {
    expect(rule).toContain('src/scenes/gym/');
    expect(rule).toContain('src/scenes/gym/core/');
  });

  it('names the game-side scene and the shared core (AC2)', () => {
    expect(rule).toContain('PlayScene');
    expect(rule).toContain('src/scenes/core/');
  });
});
