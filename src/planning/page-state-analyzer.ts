import type { Page } from '@playwright/test';

export type PageArchetype = 'authentication' | 'settings' | 'admin' | 'commerce' | 'search' | 'form' | 'content' | 'generic';

export interface PageSignals {
  url: string;
  title: string;
  headings: string[];
  bodySample: string;
  formCount: number;
  fieldCount: number;
  searchFieldCount: number;
  buttonCount: number;
  linkCount: number;
  hasDialog: boolean;
  hasTable: boolean;
}

export interface PageStateSnapshot extends PageSignals {
  archetypes: PageArchetype[];
}

export function inferArchetypes(signals: PageSignals): PageArchetype[] {
  const text = `${signals.url} ${signals.title} ${signals.headings.join(' ')} ${signals.bodySample}`.toLowerCase();
  const matches = (terms: string[]) => terms.some((term) => text.includes(term));
  const archetypes: PageArchetype[] = [];

  if (matches(['login', 'log in', 'sign in', 'register', 'sign up', 'forgot password', 'reset password', 'password'])) {
    archetypes.push('authentication');
  }
  if (matches(['settings', 'preferences', 'profile', 'account', 'security', 'appearance'])) {
    archetypes.push('settings');
  }
  if (matches(['/admin', ' admin ', 'dashboard', 'user management', 'roles', 'permissions', 'moderation'])) {
    archetypes.push('admin');
  }
  if (matches(['cart', 'checkout', 'order', 'product', 'pricing', 'payment', 'billing'])) {
    archetypes.push('commerce');
  }
  if (signals.searchFieldCount > 0 || matches(['search', 'filter', 'sort by', 'results'])) {
    archetypes.push('search');
  }
  if (signals.formCount > 0 || signals.fieldCount >= 2) {
    archetypes.push('form');
  }
  if (signals.headings.length > 0 && signals.linkCount > 0) {
    archetypes.push('content');
  }
  if (archetypes.length === 0) archetypes.push('generic');

  return [...new Set(archetypes)];
}

export class PageStateAnalyzer {
  async analyze(page: Page): Promise<PageStateSnapshot> {
    const signals = await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 12);
      const fields = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'));
      const searchFieldCount = fields.filter((element) => {
        const node = element as HTMLInputElement;
        const text = `${node.getAttribute('type') || ''} ${node.getAttribute('name') || ''} ${node.getAttribute('placeholder') || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
        return text.includes('search') || text.includes('query');
      }).length;
      return {
        title: document.title || '',
        headings,
        bodySample: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
        formCount: document.querySelectorAll('form').length,
        fieldCount: fields.length,
        searchFieldCount,
        buttonCount: document.querySelectorAll('button, [role="button"]').length,
        linkCount: document.querySelectorAll('a[href]').length,
        hasDialog: Boolean(document.querySelector('dialog, [role="dialog"], [aria-modal="true"]')),
        hasTable: Boolean(document.querySelector('table, [role="grid"], [role="table"]')),
      };
    });

    const complete: PageSignals = { url: page.url(), ...signals };
    return { ...complete, archetypes: inferArchetypes(complete) };
  }
}
