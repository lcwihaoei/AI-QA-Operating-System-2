import { describe, expect, it } from 'vitest';
import { inferArchetypes, type PageSignals } from '../src/planning/page-state-analyzer.js';

const signals = (overrides: Partial<PageSignals> = {}): PageSignals => ({
  url: 'https://example.com/',
  title: 'Example',
  headings: [],
  bodySample: '',
  formCount: 0,
  fieldCount: 0,
  searchFieldCount: 0,
  buttonCount: 0,
  linkCount: 1,
  hasDialog: false,
  hasTable: false,
  ...overrides,
});

describe('inferArchetypes', () => {
  it('recognizes authentication and form pages', () => {
    const result = inferArchetypes(signals({
      url: 'https://example.com/login',
      title: 'Sign in',
      bodySample: 'Forgot password? Sign in to your account.',
      formCount: 1,
      fieldCount: 2,
    }));
    expect(result).toContain('authentication');
    expect(result).toContain('form');
  });

  it('recognizes settings/admin/search surfaces independently', () => {
    expect(inferArchetypes(signals({ url: 'https://example.com/settings/security' }))).toContain('settings');
    expect(inferArchetypes(signals({ url: 'https://example.com/admin/users', hasTable: true }))).toContain('admin');
    expect(inferArchetypes(signals({ searchFieldCount: 1 }))).toContain('search');
  });

  it('falls back to generic when no specialized signal exists', () => {
    expect(inferArchetypes(signals())).toEqual(['generic']);
  });
});
