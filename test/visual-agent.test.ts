import { describe, expect, it } from 'vitest';
import { resolveVisualViewports, VISUAL_VIEWPORTS } from '../src/agents/visual-agent.js';

describe('visual viewport profiles', () => {
  it('exposes stable desktop, tablet and mobile dimensions', () => {
    expect(VISUAL_VIEWPORTS.desktop).toMatchObject({ width: 1440, height: 1000 });
    expect(VISUAL_VIEWPORTS.tablet).toMatchObject({ width: 768, height: 1024 });
    expect(VISUAL_VIEWPORTS.mobile).toMatchObject({ width: 390, height: 844 });
  });

  it('resolves requested profiles in order and removes duplicates', () => {
    expect(resolveVisualViewports(['mobile', 'desktop', 'mobile']).map((profile) => profile.name))
      .toEqual(['mobile', 'desktop']);
  });
});
