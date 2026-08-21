import { describe, expect, it } from 'vitest';
import { normalizeRouteSeeds, parseRouteManifest } from '../src/planning/route-manifest.js';

describe('Beta.10 route manifest', () => {
  it('accepts JSON and newline manifests and deduplicates normalized same-origin routes', () => {
    expect(parseRouteManifest('["/", "/not-found"]')).toEqual({ routes: ['/', '/not-found'] });
    expect(parseRouteManifest('# routes\n/\n/component-test\n')).toEqual({ routes: ['/', '/component-test'] });

    expect(normalizeRouteSeeds('http://localhost:5173/', [
      '/not-found',
      'http://localhost:5173/not-found#details',
      './system-status',
    ])).toEqual([
      'http://localhost:5173/not-found',
      'http://localhost:5173/system-status',
    ]);
  });

  it('fails closed for cross-origin, credential-bearing and non-http routes', () => {
    expect(() => normalizeRouteSeeds('http://localhost:5173/', ['https://example.com/admin'])).toThrow(/cross-origin/);
    expect(() => normalizeRouteSeeds('http://localhost:5173/', ['http://user:pass@localhost:5173/private'])).toThrow(/credentials/);
    expect(() => normalizeRouteSeeds('http://localhost:5173/', ['javascript:alert(1)'])).toThrow(/disallowed protocol/);
  });

  it('allows explicitly configured cross-origin normalization without weakening protocol checks', () => {
    expect(normalizeRouteSeeds('https://app.example.test/', ['https://docs.example.test/help'], false)).toEqual([
      'https://docs.example.test/help',
    ]);
    expect(() => normalizeRouteSeeds('https://app.example.test/', ['file:///tmp/test'], false)).toThrow(/disallowed protocol/);
  });

  it('bounds manifest size and validates every entry', () => {
    expect(() => parseRouteManifest(JSON.stringify({ routes: Array.from({ length: 201 }, (_, index) => `/r-${index}`) }))).toThrow(/at most 200/);
    expect(() => parseRouteManifest('{"routes":["/ok", 42]}')).toThrow(/must be a string/);
  });
});
