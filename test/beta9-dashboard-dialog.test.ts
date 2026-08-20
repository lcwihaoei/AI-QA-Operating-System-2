import { describe, expect, it } from 'vitest';
import { beta9DashboardJs } from '../src/control/beta9-dashboard.js';
import { beta9DashboardCss } from '../src/control/beta9-dashboard-ui.js';

describe('Beta.9 governed dashboard review dialogs', () => {
  it('uses in-product async dialogs instead of native prompt/confirm/alert controls', () => {
    const js = beta9DashboardJs();
    expect(js).toContain('function governedDialog');
    expect(js).toContain('Approve exact reviewed source scope');
    expect(js).toContain('Confirm bounded source mutation');
    expect(js).toContain('Correlate fresh Beta.7 evidence');
    expect(js).toContain("post('/api/beta9/select'");
    expect(js).not.toContain('window.prompt');
    expect(js).not.toContain('window.confirm');
    expect(js).not.toContain('window.alert');
  });

  it('ships responsive theme-compatible modal styles as a same-origin stylesheet', () => {
    const css = beta9DashboardCss();
    expect(css).toContain('.beta9-dialog-backdrop');
    expect(css).toContain('.beta9-dialog');
    expect(css).toContain('@media(max-width:700px)');
    expect(css).toContain('var(--panel');
  });
});
