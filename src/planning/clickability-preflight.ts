import type { Locator } from '@playwright/test';

export type ClickabilityPreflightReason =
  | 'clickable'
  | 'not-rendered'
  | 'outside-viewport'
  | 'pointer-intercepted'
  | 'evaluation-failed';

export interface ClickabilityPreflightResult {
  clickable: boolean;
  reason: ClickabilityPreflightReason;
  detail?: string;
}

/**
 * Bounded hit-target preflight used before an exploratory button click.
 *
 * Playwright can spend seconds retrying a locator whose center is covered by a
 * transient or stale overlay. Beta.10 first scrolls the element into view, then
 * checks a viewport-clamped center point with elementFromPoint. This is only a
 * safety/exploration signal; it does not itself create a product defect.
 */
export async function clickabilityPreflight(locator: Locator): Promise<ClickabilityPreflightResult> {
  await locator.scrollIntoViewIfNeeded({ timeout: 600 }).catch(() => undefined);

  return locator.evaluate((element) => {
    const node = element as HTMLElement;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { clickable: false, reason: 'not-rendered' as const, detail: 'target has zero rendered geometry' };
    }

    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) {
      return { clickable: false, reason: 'outside-viewport' as const, detail: 'target remains outside the viewport after bounded scroll preflight' };
    }

    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit) {
      return { clickable: false, reason: 'pointer-intercepted' as const, detail: 'no hit target exists at the target center point' };
    }
    if (hit === element || element.contains(hit)) {
      return { clickable: true, reason: 'clickable' as const };
    }

    const hitNode = hit as HTMLElement;
    const tag = hitNode.tagName.toLowerCase();
    const id = hitNode.id ? `#${hitNode.id}` : '';
    const classes = typeof hitNode.className === 'string'
      ? hitNode.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((value) => `.${value}`).join('')
      : '';
    return {
      clickable: false,
      reason: 'pointer-intercepted' as const,
      detail: `hit target intercepted by ${`${tag}${id}${classes}`.slice(0, 140)}`,
    };
  }).catch(() => ({
    clickable: false,
    reason: 'evaluation-failed' as const,
    detail: 'clickability preflight could not evaluate the current locator',
  }));
}
