import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';

interface StructuralInteractionState {
  path: string;
  visibleCandidates: string[];
  semanticStates: string[];
  formCount: number;
  openDialogCount: number;
}

/**
 * Capture a bounded, non-content interaction-state fingerprint.
 *
 * The fingerprint intentionally excludes field values, body text, cookies and
 * arbitrary DOM serialization. It records only structural candidate identity
 * plus a small allow-list of explicit UI state attributes. This is sufficient
 * to distinguish states such as a closed/open drawer while avoiding state churn
 * from clocks, generated prose or user-entered values.
 */
export async function captureInteractionStateFingerprint(page: Page): Promise<string> {
  const state = await page.evaluate<StructuralInteractionState>(() => {
    const candidateSelector = 'a[href], button, [role="button"], input:not([type="hidden"]), textarea, select';
    const visibleCandidates: string[] = [];
    const semanticStates: string[] = [];

    const path = location.pathname || '/';
    const identity = (element: Element, index: number): string => {
      const node = element as HTMLElement;
      const tag = node.tagName.toLowerCase();
      const id = node.id ? `id=${node.id}` : '';
      const name = node.getAttribute('name') ? `name=${node.getAttribute('name')}` : '';
      const role = node.getAttribute('role') ? `role=${node.getAttribute('role')}` : '';
      const controls = node.getAttribute('aria-controls') ? `controls=${node.getAttribute('aria-controls')}` : '';
      let href = '';
      if (node instanceof HTMLAnchorElement && node.href) {
        try { href = `href=${new URL(node.href).pathname}`; } catch { href = ''; }
      }
      const type = node.getAttribute('type') ? `type=${node.getAttribute('type')}` : '';
      return [tag, id || name || controls || href || role || `ordinal=${index}`, type].filter(Boolean).join('|').slice(0, 220);
    };

    const rendered = (element: Element): boolean => {
      const node = element as HTMLElement;
      if (node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity || '1') <= 0.01) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    Array.from(document.querySelectorAll(candidateSelector)).slice(0, 160).forEach((element, index) => {
      if (rendered(element)) visibleCandidates.push(identity(element, index));
    });

    const allowedStateValue = (value: string | null): string | undefined => {
      if (!value) return undefined;
      const normalized = value.trim().toLowerCase();
      return /^(true|false|open|closed|active|inactive|expanded|collapsed|selected|unselected|on|off)$/.test(normalized)
        ? normalized
        : undefined;
    };

    Array.from(document.querySelectorAll('[aria-expanded],[aria-selected],[aria-pressed],[data-state],dialog,[open]'))
      .slice(0, 100)
      .forEach((element, index) => {
        const parts = [
          `node=${identity(element, index)}`,
          allowedStateValue(element.getAttribute('aria-expanded')) ? `expanded=${allowedStateValue(element.getAttribute('aria-expanded'))}` : '',
          allowedStateValue(element.getAttribute('aria-selected')) ? `selected=${allowedStateValue(element.getAttribute('aria-selected'))}` : '',
          allowedStateValue(element.getAttribute('aria-pressed')) ? `pressed=${allowedStateValue(element.getAttribute('aria-pressed'))}` : '',
          allowedStateValue(element.getAttribute('data-state')) ? `state=${allowedStateValue(element.getAttribute('data-state'))}` : '',
          element.hasAttribute('open') ? 'open=true' : '',
        ].filter(Boolean);
        semanticStates.push(parts.join('|').slice(0, 320));
      });

    visibleCandidates.sort();
    semanticStates.sort();
    return {
      path,
      visibleCandidates,
      semanticStates,
      formCount: document.forms.length,
      openDialogCount: document.querySelectorAll('dialog[open],[role="dialog"]:not([aria-hidden="true"])').length,
    };
  });

  return createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex')
    .slice(0, 20);
}
