import { parseDocument } from 'yaml';

export type OpenApiDocumentFormat = 'json' | 'yaml';

export interface ParsedOpenApiDocument {
  document: unknown;
  format: OpenApiDocumentFormat;
}

const MAX_OPENAPI_SOURCE_CHARS = 2_000_000;
const MAX_YAML_ALIASES = 50;

function looksJson(contentType: string, url: string): boolean {
  return /(?:application|text)\/(?:[^;]+\+)?json/i.test(contentType) || /\.json(?:$|[?#])/i.test(url);
}

function looksYaml(contentType: string, url: string): boolean {
  return /(?:application|text)\/(?:x-)?ya?ml/i.test(contentType) || /\.ya?ml(?:$|[?#])/i.test(url);
}

function parseJson(source: string): unknown {
  return JSON.parse(source);
}

function parseYaml(source: string): unknown {
  const parsed = parseDocument(source, { prettyErrors: false });
  if (parsed.errors.length > 0) {
    throw new Error(`YAML parse error: ${parsed.errors[0]?.message ?? 'invalid document'}`);
  }
  return parsed.toJS({ maxAliasCount: MAX_YAML_ALIASES });
}

export function parseOpenApiSource(source: string, contentType: string, url: string): ParsedOpenApiDocument {
  if (source.length > MAX_OPENAPI_SOURCE_CHARS) {
    throw new Error(`OpenAPI source exceeds ${MAX_OPENAPI_SOURCE_CHARS} character limit`);
  }

  if (looksJson(contentType, url)) {
    return { document: parseJson(source), format: 'json' };
  }
  if (looksYaml(contentType, url)) {
    return { document: parseYaml(source), format: 'yaml' };
  }

  try {
    return { document: parseJson(source), format: 'json' };
  } catch {
    return { document: parseYaml(source), format: 'yaml' };
  }
}
