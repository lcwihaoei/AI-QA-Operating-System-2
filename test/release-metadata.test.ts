import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Beta.9 release candidate metadata', () => {
  it('keeps package, manifest and release-note versions aligned', async () => {
    const [packageText, manifestText, notes] = await Promise.all([
      readFile('package.json', 'utf8'),
      readFile('release-manifest.json', 'utf8'),
      readFile('RELEASE_NOTES.md', 'utf8'),
    ]);
    const pkg = JSON.parse(packageText) as { version?: string };
    const manifest = JSON.parse(manifestText) as {
      version?: string;
      channel?: string;
      validation?: { required?: string[] };
    };

    expect(pkg.version).toBe('0.10.0-beta.9');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.channel).toBe('prerelease');
    expect(notes.startsWith(`# AI QA Operating System v${pkg.version}\n`)).toBe(true);
  });

  it('keeps the Beta.8/Beta.9 release-critical gates represented in the manifest', async () => {
    const manifest = JSON.parse(await readFile('release-manifest.json', 'utf8')) as {
      validation?: { required?: string[] };
    };
    const required = new Set(manifest.validation?.required ?? []);

    for (const gate of [
      'beta8-frontend-discovery-matrix',
      'beta8-controlled-backend-executor',
      'beta8-source-by-source-mock-migration',
      'beta8-final-beta7-qa-handoff',
      'beta9-selected-finding-plan-approval-execute',
      'beta9-post-qa-correlation-bounded-retry',
      'beta9-safe-fresh-result-discovery',
      'feature-planner-contract-and-dashboard-http',
      'feature-planner-desktop-mobile-bilingual-e2e',
    ]) {
      expect(required.has(gate), `missing release gate: ${gate}`).toBe(true);
    }
  });

  it('requires an explicit matching prerelease tag and keeps the bilingual browser gate in release CI', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain("tags:\n      - 'v0.10.0-beta.*'");
    expect(workflow).not.toContain('branches:\n      - feature/v0.10.0-beta.9-controlled-auto-fix');
    expect(workflow).toContain('test "$GITHUB_REF_TYPE" = "tag"');
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "$TAG"');
    expect(workflow).toContain('test/feature-planner-browser-e2e.test.ts');
    expect(workflow).toContain('npm audit --audit-level=high');
    expect(workflow).toContain('npm pack --dry-run');
    expect(workflow).toContain('sha256sum *.tgz > SHA256SUMS.txt');
  });
});
