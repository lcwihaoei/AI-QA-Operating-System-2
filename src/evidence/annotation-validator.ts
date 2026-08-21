import type { AnnotationStatus } from '../contracts/quality-contracts.js';

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationValidation {
  status: AnnotationStatus;
  reason: string;
  primary: AnnotationRect;
  secondary?: AnnotationRect;
  intersection?: AnnotationRect;
}

function hasArea(rect: AnnotationRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function intersection(a: AnnotationRect, b: AnnotationRect): AnnotationRect | undefined {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleIntersection(rect: AnnotationRect, viewportWidth: number, viewportHeight: number): AnnotationRect | undefined {
  return intersection(rect, { x: 0, y: 0, width: viewportWidth, height: viewportHeight });
}

export function validateOffscreenAnnotation(
  rect: AnnotationRect,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationValidation {
  if (!hasArea(rect)) {
    return { status: 'rejected', reason: 'element rectangle has no positive area', primary: rect };
  }

  const visible = visibleIntersection(rect, viewportWidth, viewportHeight);
  if (!visible) {
    return {
      status: 'unverified',
      reason: 'element is entirely outside the screenshot viewport; a clipped on-image marker cannot prove the offscreen geometry',
      primary: rect,
    };
  }

  const fullyInside = visible.x === rect.x
    && visible.y === rect.y
    && visible.width === rect.width
    && visible.height === rect.height;

  if (fullyInside) {
    return {
      status: 'rejected',
      reason: 'element rectangle is fully visible inside the viewport, so an offscreen annotation is inconsistent with its geometry',
      primary: rect,
    };
  }

  return {
    status: 'confirmed',
    reason: 'element rectangle is partially clipped by the viewport and can be annotated using the visible intersection',
    primary: rect,
    intersection: visible,
  };
}

export function validateOverlapAnnotation(
  first: AnnotationRect,
  second: AnnotationRect,
  viewportWidth: number,
  viewportHeight: number,
): AnnotationValidation {
  if (!hasArea(first) || !hasArea(second)) {
    return { status: 'rejected', reason: 'both overlap rectangles must have positive area', primary: first, secondary: second };
  }

  const overlap = intersection(first, second);
  if (!overlap) {
    return { status: 'rejected', reason: 'the two rectangles do not geometrically overlap', primary: first, secondary: second };
  }

  const visibleOverlap = visibleIntersection(overlap, viewportWidth, viewportHeight);
  if (!visibleOverlap) {
    return {
      status: 'unverified',
      reason: 'the computed overlap exists entirely outside the screenshot viewport and cannot be visually confirmed from this image',
      primary: first,
      secondary: second,
      intersection: overlap,
    };
  }

  return {
    status: 'confirmed',
    reason: 'both element rectangles and their visible intersection can be represented in the screenshot annotation',
    primary: first,
    secondary: second,
    intersection: visibleOverlap,
  };
}
