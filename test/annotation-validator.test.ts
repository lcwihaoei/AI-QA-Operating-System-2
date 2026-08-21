import { describe, expect, it } from 'vitest';
import { validateOffscreenAnnotation, validateOverlapAnnotation } from '../src/evidence/annotation-validator.js';

describe('Annotation Validator', () => {
  it('refuses to pretend an entirely offscreen element can be proven by an on-image marker', () => {
    const result = validateOffscreenAnnotation(
      { x: -140, y: 25, width: 64, height: 29 },
      1440,
      1000,
    );

    expect(result.status).toBe('unverified');
    expect(result.reason).toContain('entirely outside');
  });

  it('confirms a partially clipped element using only the visible intersection', () => {
    const result = validateOffscreenAnnotation(
      { x: -20, y: 20, width: 60, height: 40 },
      390,
      844,
    );

    expect(result.status).toBe('confirmed');
    expect(result.intersection).toEqual({ x: 0, y: 20, width: 40, height: 40 });
  });

  it('rejects an offscreen label when the full element rectangle is visible', () => {
    const result = validateOffscreenAnnotation(
      { x: 20, y: 20, width: 60, height: 40 },
      390,
      844,
    );

    expect(result.status).toBe('rejected');
  });

  it('requires two rectangles and annotates the actual intersection for overlap findings', () => {
    const result = validateOverlapAnnotation(
      { x: 10, y: 10, width: 100, height: 80 },
      { x: 80, y: 40, width: 100, height: 80 },
      390,
      844,
    );

    expect(result.status).toBe('confirmed');
    expect(result.secondary).toEqual({ x: 80, y: 40, width: 100, height: 80 });
    expect(result.intersection).toEqual({ x: 80, y: 40, width: 30, height: 50 });
  });

  it('marks overlap outside the screenshot viewport as unverified instead of visually confirmed', () => {
    const result = validateOverlapAnnotation(
      { x: -100, y: 10, width: 80, height: 80 },
      { x: -80, y: 20, width: 70, height: 70 },
      390,
      844,
    );

    expect(result.status).toBe('unverified');
  });
});
