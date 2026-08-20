import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('QA production runtime entrypoint', () => {
  it('runs the QA CLI from compiled JavaScript instead of tsx browser serialization', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.qa).toContain('node dist/src/cli.js');
    expect(pkg.scripts?.qa).not.toContain('tsx src/cli.ts');
  });
});
