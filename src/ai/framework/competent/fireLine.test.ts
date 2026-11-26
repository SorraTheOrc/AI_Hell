/**
 * Fire-line predicate tests (AH-0MWPOET5A002IPTP · fire-discipline remediation).
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_FIRE_LINE_RADIUS_PX,
  hasFireLine,
  type FireLineTarget,
} from './fireLine';

const origin = { x: 100, y: 100 };
const target = (overrides: Partial<FireLineTarget> = {}): FireLineTarget => ({
  x: 200,
  y: 100,
  alive: true,
  radius: 10,
  ...overrides,
});

describe('hasFireLine', () => {
  it('fires at a live body straight ahead inside reach', () => {
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 250,
        targets: [target()],
      }),
    ).toBe(true);
  });

  it('does not fire when every body is behind the muzzle', () => {
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 250,
        targets: [target({ x: 0 })],
      }),
    ).toBe(false);
  });

  it('does not fire when the body is out of the weapon reach', () => {
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 50,
        targets: [target({ x: 200 })],
      }),
    ).toBe(false);
  });

  it('counts the body radius and the bullet allowance as reach slack', () => {
    // Body centre 260 px away, 11 px radius -> reach 250 + 11 = 261.
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 250,
        targets: [target({ x: 360, radius: 11 })],
      }),
    ).toBe(true);
  });

  it('does not fire when the body is off the shot line', () => {
    // 200 px ahead but 50 px to the side, well outside a 10 px radius.
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 400,
        targets: [target({ y: 150 })],
      }),
    ).toBe(false);
  });

  it('accepts a body within its own hit radius of the line', () => {
    // 8 px off the line, 10 px radius: the bullet would clip the body.
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 400,
        targets: [target({ y: 108 })],
      }),
    ).toBe(true);
  });

  it('honours the documented bullet allowance constant', () => {
    // Just inside `radius + allowance`, just outside it.
    const inside = 10 + BOT_FIRE_LINE_RADIUS_PX - 1;
    const outside = 10 + BOT_FIRE_LINE_RADIUS_PX + 1;
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 400,
        targets: [target({ y: 100 + inside })],
      }),
    ).toBe(true);
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 400,
        targets: [target({ y: 100 + outside })],
      }),
    ).toBe(false);
  });

  it('ignores dead bodies', () => {
    expect(
      hasFireLine({
        origin,
        heading: 0,
        weaponRange: 250,
        targets: [target({ alive: false })],
      }),
    ).toBe(false);
  });

  it('rotates the fire line with the heading', () => {
    // Body below the ship; a right-facing shot must not fire, a down-facing one must.
    const below = target({ x: 100, y: 200 });
    expect(
      hasFireLine({ origin, heading: 0, weaponRange: 250, targets: [below] }),
    ).toBe(false);
    expect(
      hasFireLine({
        origin,
        heading: Math.PI / 2,
        weaponRange: 250,
        targets: [below],
      }),
    ).toBe(true);
  });

  it('judges a body across a torus seam on its shortest wrapped offset', () => {
    const world = { width: 200, height: 200 };
    // Ship at x=190, body at x=10: 20 px ahead through the seam.
    expect(
      hasFireLine({
        origin: { x: 190, y: 100 },
        heading: 0,
        weaponRange: 100,
        targets: [target({ x: 10, y: 100 })],
        world,
      }),
    ).toBe(true);
  });

  it('never suppresses when the weapon reach is unknown', () => {
    for (const weaponRange of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        hasFireLine({
          origin,
          heading: 0,
          weaponRange,
          targets: [],
        }),
      ).toBe(true);
    }
  });
});
