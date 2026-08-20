import { describe, expect, it } from 'vitest';
import { HttpVisualEvidenceProvider } from '../src/providers/http-visual-evidence-provider.js';
import { isSecureVisualEndpoint } from '../src/security/url-policy.js';

describe('visual endpoint transport policy', () => {
  it('allows HTTPS endpoints', () => {
    expect(isSecureVisualEndpoint('https://vision.example.com/v1/assess')).toBe(true);
    expect(() => new HttpVisualEvidenceProvider('https://vision.example.com/v1/assess')).not.toThrow();
  });

  it('allows HTTP only on loopback', () => {
    expect(isSecureVisualEndpoint('http://localhost:8080/assess')).toBe(true);
    expect(isSecureVisualEndpoint('http://127.0.0.1:8080/assess')).toBe(true);
    expect(isSecureVisualEndpoint('http://example.com/assess')).toBe(false);
    expect(isSecureVisualEndpoint('http://192.168.1.20:8080/assess')).toBe(false);
    expect(() => new HttpVisualEvidenceProvider('http://example.com/assess')).toThrow(/HTTPS/);
  });

  it('rejects malformed and non-http protocols', () => {
    expect(isSecureVisualEndpoint('not a url')).toBe(false);
    expect(isSecureVisualEndpoint('ftp://example.com/file')).toBe(false);
  });
});
