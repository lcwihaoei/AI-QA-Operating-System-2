import type { Page } from '@playwright/test';

export type VisualSignalKind =
  | 'horizontal-overflow'
  | 'interactive-offscreen'
  | 'text-clipping'
  | 'interactive-overlap';

export type VisualSignalSeverity = 'medium' | 'low';

export interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualSignal {
  kind: VisualSignalKind;
  severity: VisualSignalSeverity;
  message: string;
  element?: string;
  relatedElement?: string;
  rect?: RectSnapshot;
  relatedRect?: RectSnapshot;
  details?: Record<string, unknown>;
}

export function intersectionArea(a: RectSnapshot, b: RectSnapshot): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

export function meaningfulOverlap(a: RectSnapshot, b: RectSnapshot, minimumRatio = 0.18): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  const overlap = intersectionArea(a, b);
  if (overlap <= 0) return false;
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 && overlap / smallerArea >= minimumRatio;
}

export function isActionablyOffscreen(rect: RectSnapshot, viewportWidth: number): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const horizontallyImpossible = rect.x + rect.width <= 0
    || rect.x >= viewportWidth
    || rect.x < -4
    || rect.x + rect.width > viewportWidth + 4;
  const aboveViewport = rect.y + rect.height <= 0;
  // Deliberately do not treat y >= viewport height as a defect: normal long pages
  // place reachable controls below the fold and users can scroll to them.
  return horizontallyImpossible || aboveViewport;
}

export class DomGeometryAnalyzer {
  async analyze(page: Page): Promise<VisualSignal[]> {
    const raw = await page.evaluate(() => {
      type BrowserRect = { x: number; y: number; width: number; height: number };
      type BrowserElement = {
        key: number;
        element: Element;
        description: string;
        rect: BrowserRect;
      };
      type BrowserSignal = {
        kind: 'horizontal-overflow' | 'interactive-offscreen' | 'text-clipping';
        severity: 'medium' | 'low';
        message: string;
        element?: string;
        rect?: BrowserRect;
        details?: Record<string, unknown>;
      };

      const describe = (element: Element): string => {
        const node = element as HTMLElement;
        const id = node.id ? `#${node.id}` : '';
        const classes = typeof node.className === 'string'
          ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((value) => `.${value}`).join('')
          : '';
        const label = (
          node.getAttribute('aria-label') ||
          node.getAttribute('name') ||
          node.getAttribute('placeholder') ||
          node.textContent ||
          ''
        ).replace(/\s+/g, ' ').trim().slice(0, 80);
        return `${node.tagName.toLowerCase()}${id}${classes}${label ? ` "${label}"` : ''}`.slice(0, 180);
      };

      const rectOf = (element: Element): BrowserRect => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };

      const isVisuallyHiddenClass = (node: HTMLElement): boolean => node.classList.contains('visually-hidden')
        || node.classList.contains('sr-only')
        || node.classList.contains('screen-reader-text');

      const isClosedBootstrapOffcanvas = (node: HTMLElement): boolean => {
        if (!node.classList.contains('offcanvas')) return false;
        const explicitlyOpen = node.classList.contains('show')
          || node.getAttribute('data-state') === 'open'
          || node.getAttribute('data-open') === 'true'
          || node.getAttribute('aria-hidden') === 'false';
        return !explicitlyOpen;
      };

      const isSuppressedByDesign = (element: Element): boolean => {
        let current: HTMLElement | null = element as HTMLElement;
        while (current) {
          if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return true;
          if (current.getAttribute('data-state') === 'closed' || current.getAttribute('data-open') === 'false') return true;
          if (isVisuallyHiddenClass(current) || isClosedBootstrapOffcanvas(current)) return true;

          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
          if (Number(style.opacity || '1') <= 0.01 || style.contentVisibility === 'hidden') return true;
          current = current.parentElement;
        }
        return false;
      };

      const isVisible = (element: Element): boolean => {
        if (isSuppressedByDesign(element)) return false;
        const rect = (element as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const isActionableInteractive = (element: Element): boolean => {
        if (!isVisible(element)) return false;
        const node = element as HTMLElement & { disabled?: boolean };
        if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') return false;
        return true;
      };

      const offscreenState = (rect: BrowserRect): { horizontallyImpossible: boolean; aboveViewport: boolean } => ({
        horizontallyImpossible: rect.x + rect.width <= 0
          || rect.x >= window.innerWidth
          || rect.x < -4
          || rect.x + rect.width > window.innerWidth + 4,
        aboveViewport: rect.y + rect.height <= 0,
      });

      const hasHorizontallyScrollableAncestor = (element: Element): boolean => {
        let current = element.parentElement;
        while (current && current !== document.documentElement) {
          const style = getComputedStyle(current);
          const overflowX = style.overflowX || style.overflow;
          if ((overflowX === 'auto' || overflowX === 'scroll') && current.scrollWidth > current.clientWidth + 2) return true;
          current = current.parentElement;
        }
        return false;
      };

      const isIntentionalTextTruncation = (style: CSSStyleDeclaration): boolean => {
        if (style.textOverflow === 'ellipsis') return true;
        const lineClamp = style.getPropertyValue('-webkit-line-clamp').trim();
        return lineClamp !== '' && lineClamp !== 'none' && lineClamp !== '0';
      };

      const signals: BrowserSignal[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 4) {
        signals.push({
          kind: 'horizontal-overflow',
          severity: 'medium',
          message: `Document is horizontally overflowing by ${root.scrollWidth - root.clientWidth}px`,
          details: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
        });
      }

      const interactiveSelector = 'a[href], button, [role="button"], input:not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"])';
      const interactive: BrowserElement[] = Array.from(document.querySelectorAll(interactiveSelector))
        .filter(isActionableInteractive)
        .slice(0, 220)
        .map((element, key) => ({ key, element, description: describe(element), rect: rectOf(element) }));

      for (const item of interactive) {
        const state = offscreenState(item.rect);
        const horizontallyReachable = state.horizontallyImpossible && hasHorizontallyScrollableAncestor(item.element);
        if (state.aboveViewport || (state.horizontallyImpossible && !horizontallyReachable)) {
          signals.push({
            kind: 'interactive-offscreen',
            severity: 'medium',
            message: `Interactive element is unreachable or clipped by the viewport: ${item.description}`,
            element: item.description,
            rect: item.rect,
            details: {
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight,
              horizontallyImpossible: state.horizontallyImpossible,
              aboveViewport: state.aboveViewport,
            },
          });
        }
      }

      const textSelector = 'button, a[href], label, p, span, li, h1, h2, h3, h4, h5, h6, [role="button"], [role="alert"], [role="status"]';
      const textElements = Array.from(document.querySelectorAll(textSelector)).filter(isVisible).slice(0, 350);
      for (const element of textElements) {
        const node = element as HTMLElement;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const style = getComputedStyle(node);
        const clipsX = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflow);
        const clipsY = ['hidden', 'clip'].includes(style.overflowY) || ['hidden', 'clip'].includes(style.overflow);
        const clippedX = clipsX && node.scrollWidth > node.clientWidth + 2;
        const clippedY = clipsY && node.scrollHeight > node.clientHeight + 2;
        if (!clippedX && !clippedY) continue;
        if (isIntentionalTextTruncation(style)) continue;
        const description = describe(element);
        signals.push({
          kind: 'text-clipping',
          severity: 'medium',
          message: `Visible text appears clipped: ${description}`,
          element: description,
          rect: rectOf(element),
          details: {
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            clientHeight: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          },
        });
      }

      return {
        signals,
        interactive: interactive.map((item) => ({
          key: item.key,
          description: item.description,
          rect: item.rect,
          ancestorKeys: interactive
            .filter((other) => other.key !== item.key && other.element.contains(item.element))
            .map((other) => other.key),
        })),
      };
    });

    const signals: VisualSignal[] = [...raw.signals];
    const candidates = raw.interactive;
    let overlapCount = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const a = candidates[i]!;
      for (let j = i + 1; j < candidates.length; j += 1) {
        const b = candidates[j]!;
        if (a.ancestorKeys.includes(b.key) || b.ancestorKeys.includes(a.key)) continue;
        if (!meaningfulOverlap(a.rect, b.rect)) continue;
        signals.push({
          kind: 'interactive-overlap',
          severity: 'medium',
          message: `Interactive elements substantially overlap: ${a.description} ↔ ${b.description}`,
          element: a.description,
          relatedElement: b.description,
          rect: a.rect,
          relatedRect: b.rect,
          details: { intersectionArea: intersectionArea(a.rect, b.rect) },
        });
        overlapCount += 1;
        if (overlapCount >= 20) break;
      }
      if (overlapCount >= 20) break;
    }

    const deduped = new Map<string, VisualSignal>();
    for (const signal of signals) {
      const key = `${signal.kind}|${signal.element ?? ''}|${signal.relatedElement ?? ''}|${signal.message}`;
      if (!deduped.has(key)) deduped.set(key, signal);
      if (deduped.size >= 60) break;
    }
    return [...deduped.values()];
  }
}
