import { describe, expect, it } from 'vitest';
import { intersectionArea, isActionablyOffscreen, meaningfulOverlap } from '../src/visual/dom-geometry-analyzer.js';

describe('DOM geometry helpers', () => {
  it('computes rectangle intersection area', () => {
    expect(intersectionArea(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 50, y: 10, width: 100, height: 40 },
    )).toBe(2000);
  });

  it('detects substantial overlap relative to the smaller element', () => {
    expect(meaningfulOverlap(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 20, y: 5, width: 80, height: 40 },
    )).toBe(true);
  });

  it('ignores tiny incidental intersections', () => {
    expect(meaningfulOverlap(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 98, y: 48, width: 100, height: 50 },
    )).toBe(false);
  });

  it('ignores zero-sized geometry', () => {
    expect(meaningfulOverlap(
      { x: 0, y: 0, width: 0, height: 50 },
      { x: 0, y: 0, width: 100, height: 50 },
    )).toBe(false);
  });

  it('does not classify normal below-fold controls as offscreen defects', () => {
    expect(isActionablyOffscreen({ x: 40, y: 1800, width: 120, height: 40 }, 1440)).toBe(false);
  });

  it('still classifies horizontally unreachable controls as offscreen', () => {
    expect(isActionablyOffscreen({ x: -160, y: 300, width: 120, height: 40 }, 1440)).toBe(true);
    expect(isActionablyOffscreen({ x: 1500, y: 300, width: 120, height: 40 }, 1440)).toBe(true);
  });
});
