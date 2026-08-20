import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export interface JsonSchemaIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
}

export interface JsonSchemaValidationResult {
  valid: boolean;
  issues: JsonSchemaIssue[];
  toolingError?: string;
}

const MAX_SCHEMA_CHARS = 1_000_000;
const MAX_ISSUES = 30;

function serializeSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function issue(error: ErrorObject): JsonSchemaIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
    params: error.params as Record<string, unknown>,
  };
}

export class JsonSchemaValidator {
  private readonly ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    allowUnionTypes: true,
  });
  private readonly cache = new Map<string, ValidateFunction>();

  validate(schema: unknown, payload: unknown): JsonSchemaValidationResult {
    const schemaText = this.schemaText(schema);
    if (!schemaText) {
      return {
        valid: true,
        issues: [],
        toolingError: 'JSON Schema is not serializable or exceeds the validation size limit',
      };
    }

    try {
      let validate = this.cache.get(schemaText);
      if (!validate) {
        const compiled = this.ajv.compile(JSON.parse(schemaText));
        if (this.cache.size >= 200) this.cache.clear();
        this.cache.set(schemaText, compiled);
        validate = compiled;
      }
      const valid = Boolean(validate(payload));
      return {
        valid,
        issues: (validate.errors ?? []).slice(0, MAX_ISSUES).map(issue),
      };
    } catch (error: unknown) {
      return {
        valid: true,
        issues: [],
        toolingError: `JSON Schema validator could not compile/execute schema: ${String(error)}`,
      };
    }
  }

  private schemaText(schema: unknown): string | undefined {
    if (schema === undefined) return undefined;
    if (serializeSize(schema) > MAX_SCHEMA_CHARS) return undefined;
    try {
      return JSON.stringify(schema);
    } catch {
      return undefined;
    }
  }
}
