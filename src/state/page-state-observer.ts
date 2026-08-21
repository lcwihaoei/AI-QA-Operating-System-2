import type { PageStateObservation, VisibilityState } from '../contracts/quality-contracts.js';

export interface RectSignal {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisibilitySignalInput {
  stateId: string;
  url: string;
  observedAt: string;
  rect?: RectSignal;
  viewportWidth?: number;
  viewportHeight?: number;
  display?: string;
  cssVisibility?: string;
  opacity?: number;
  hiddenAttribute?: boolean;
  inert?: boolean;
  ariaHidden?: boolean;
  controlledBy?: string;
  ownerExpanded?: boolean;
  transformed?: boolean;
}

function entirelyOutsideViewport(input: VisibilitySignalInput): boolean {
  const { rect, viewportWidth, viewportHeight } = input;
  if (!rect || viewportWidth === undefined || viewportHeight === undefined) return false;
  return rect.x + rect.width <= 0
    || rect.y + rect.height <= 0
    || rect.x >= viewportWidth
    || rect.y >= viewportHeight;
}

function inferVisibility(input: VisibilitySignalInput, reasons: string[]): VisibilityState {
  if (input.hiddenAttribute || input.display === 'none' || input.cssVisibility === 'hidden') {
    reasons.push('element is not rendered by explicit HTML/CSS visibility state');
    return 'not-rendered';
  }

  if (input.ariaHidden === true || input.inert === true) {
    reasons.push(input.ariaHidden === true ? 'aria-hidden=true' : 'inert=true');
    return 'intentionally-hidden';
  }

  const offscreen = entirelyOutsideViewport(input);
  if (input.controlledBy && input.ownerExpanded === false && offscreen) {
    reasons.push('controlled region is collapsed and its geometry is displaced outside the viewport');
    return 'intentionally-hidden';
  }

  if (offscreen) {
    reasons.push('geometry is outside the viewport without an explicit collapsed-state contract');
    return 'unknown';
  }

  if (input.transformed) {
    reasons.push('transform exists but does not by itself prove hidden state');
  }

  reasons.push('element remains geometrically reachable and has no explicit hidden state');
  return 'visible';
}

export function observePageVisibility(input: VisibilitySignalInput): PageStateObservation {
  const reasons: string[] = [];
  const visibility = inferVisibility(input, reasons);
  return {
    stateId: input.stateId,
    url: input.url,
    observedAt: input.observedAt,
    visibility,
    controlledBy: input.controlledBy,
    expanded: input.ownerExpanded,
    inert: input.inert,
    ariaHidden: input.ariaHidden,
    reasons,
  };
}
