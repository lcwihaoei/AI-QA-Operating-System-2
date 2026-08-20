import { describe, expect, it } from 'vitest';
import { JsonSchemaValidator } from '../src/api/json-schema-validator.js';
import { contractForStatus, parseOpenApiOperations } from '../src/api/openapi-model.js';

describe('JSON Schema response validation', () => {
  it('validates nested objects, arrays, enum and scalar types', () => {
    const validator = new JsonSchemaValidator();
    const schema = {
      type: 'object',
      required: ['status', 'items'],
      properties: {
        status: { enum: ['active', 'disabled'] },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['id', 'score'],
            properties: {
              id: { type: 'integer' },
              score: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    };

    expect(validator.validate(schema, { status: 'active', items: [{ id: 1, score: 9.5 }] }).valid).toBe(true);
    const invalid = validator.validate(schema, { status: 'unknown', items: [{ id: '1', score: -2 }] });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((item) => item.keyword)).toEqual(expect.arrayContaining(['enum', 'type', 'minimum']));
  });

  it('rewrites OpenAPI component refs into standalone $defs including recursive refs', () => {
    const document = {
      openapi: '3.1.0',
      components: {
        schemas: {
          User: {
            type: 'object',
            required: ['id', 'role'],
            properties: {
              id: { type: 'integer' },
              role: { enum: ['admin', 'member'] },
              manager: { $ref: '#/components/schemas/User' },
            },
          },
        },
      },
      paths: {
        '/me': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/User' } },
                },
              },
            },
          },
        },
      },
    };

    const operation = parseOpenApiOperations(document)[0]!;
    const contract = contractForStatus(operation, 200)!;
    const validator = new JsonSchemaValidator();
    expect(validator.validate(contract.schema, { id: 1, role: 'member', manager: { id: 2, role: 'admin' } }).valid).toBe(true);
    const invalid = validator.validate(contract.schema, { id: 'bad', role: 'owner' });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((item) => item.keyword)).toEqual(expect.arrayContaining(['type', 'enum']));
  });

  it('treats invalid schemas as tooling errors rather than product failures', () => {
    const validator = new JsonSchemaValidator();
    const result = validator.validate({ type: 'definitely-not-a-json-schema-type' }, { anything: true });
    expect(result.valid).toBe(true);
    expect(result.toolingError).toContain('could not compile');
  });
});
