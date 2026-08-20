import type { Page } from '@playwright/test';
import type { UxPageSnapshot } from './ux-types.js';

export function uxPathInfo(value: string): { urlPath: string; routeDepth: number } {
  const url = new URL(value);
  const path = url.pathname || '/';
  return { urlPath: path.slice(0, 1_000), routeDepth: path.split('/').filter(Boolean).length };
}

export async function captureUxPageSnapshot(page: Page, targetUrl: string): Promise<UxPageSnapshot> {
  const aggregate = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,[role="button"],[role="link"]',
    )).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || '1') > 0.01
        && rect.width > 0
        && rect.height > 0;
    });

    const accessible = (element: HTMLElement) => (
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('name')
      || element.textContent
      || ''
    ).replace(/\s+/g, ' ').trim();

    const primaryKinds = new Set<string>();
    let ambiguousActionCount = 0;
    const classify = (text: string) => {
      const value = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const rules: Array<[string, RegExp]> = [
        ['save', /\b(save|儲存|保存)\b/],
        ['apply', /\bapply\b|套用/],
        ['update', /\bupdate\b|更新/],
        ['confirm', /\bconfirm\b|確認|确认/],
        ['continue', /\b(continue|next)\b|繼續|继续|下一步/],
        ['submit', /\bsubmit\b|提交/],
        ['create', /\b(create|add|new)\b|建立|新增|创建/],
        ['start', /\b(start|get started|begin)\b|開始|开始/],
        ['search', /\bsearch\b|搜尋|搜索/],
        ['login', /\b(log in|login|sign in)\b|登入|登錄|登录/],
      ];
      for (const [kind, pattern] of rules) if (pattern.test(value)) primaryKinds.add(kind);
      if (/^(more|open|here|click here|learn more|更多|開啟|开启|打开|這裡|这里)$/i.test(value)) {
        ambiguousActionCount += 1;
      }
    };
    for (const control of controls) classify(accessible(control));

    const textChars = Math.min((document.body?.innerText ?? '').length, 2_000_000);
    const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    const title = document.title.trim();
    return {
      interactiveCount: controls.length,
      buttonCount: controls.filter((element) => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button').length,
      linkCount: controls.filter((element) => element.tagName === 'A' || element.getAttribute('role') === 'link').length,
      formFieldCount: document.querySelectorAll('input,select,textarea').length,
      unlabeledInteractiveCount: controls.filter((element) => accessible(element).length === 0).length,
      headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      h1Count: document.querySelectorAll('h1').length,
      primaryActionKinds: Array.from(primaryKinds),
      ambiguousActionCount,
      textChars,
      scrollRatio: Math.round((scrollHeight / Math.max(window.innerHeight, 1)) * 10) / 10,
      navLandmarks: document.querySelectorAll('nav,[role="navigation"]').length,
      hasMeaningfulTitle: title.length >= 3 && !/^(home|app|untitled|index)$/i.test(title),
    };
  });

  return { ...uxPathInfo(targetUrl), ...aggregate };
}
