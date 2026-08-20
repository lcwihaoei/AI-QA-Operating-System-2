import { describe, expect, it } from 'vitest';
import { parseOpenApiSource } from '../src/api/openapi-document-parser.js';

describe('OpenAPI JSON/YAML source parser', () => {
  it('parses JSON by content type', () => {
    const result = parseOpenApiSource('{"openapi":"3.1.0","paths":{}}', 'application/json', 'https://example.com/openapi');
    expect(result.format).toBe('json');
    expect(result.document).toMatchObject({ openapi: '3.1.0' });
  });

  it('parses YAML by extension and preserves OpenAPI structure', () => {
    const source = [
      'openapi: 3.1.0',
      'paths:',
      '  /health:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
    ].join('\n');
    const result = parseOpenApiSource(source, 'text/plain', 'https://example.com/openapi.yaml');
    expect(result.format).toBe('yaml');
    expect(result.document).toMatchObject({
      openapi: '3.1.0',
      paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } } },
    });
  });

  it('falls back from unknown content type to YAML', () => {
    const result = parseOpenApiSource('openapi: 3.1.0\npaths: {}\n', 'text/plain', 'https://example.com/schema');
    expect(result.format).toBe('yaml');
  });

  it('rejects malformed YAML instead of returning a partial contract', () => {
    expect(() => parseOpenApiSource('openapi: [\npaths:', 'application/yaml', 'https://example.com/openapi.yaml'))
      .toThrow(/YAML parse error/);
  });

  it('bounds YAML alias expansion', () => {
    const aliases = Array.from({ length: 80 }, () => '*base').join(', ');
    const source = `base: &base { value: 1 }\nopenapi: 3.1.0\npaths: {}\nitems: [${aliases}]\n`;
    expect(() => parseOpenApiSource(source, 'application/yaml', 'https://example.com/openapi.yaml'))
      .toThrow();
  });
});
