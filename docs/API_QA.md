# API QA

M4 is the provider-neutral API testing layer that follows browser exploration. It now includes bounded JSON/YAML OpenAPI discovery, safe read testing, response-schema validation, browser/network/API causal correlation, cleanup-safe disposable sandbox lifecycles, and a conservative read-only API↔UI semantic state oracle.

## Discovery and authentication

The API layer probes a bounded set of same-origin `openapi.*`, `swagger.*`, `/v3/api-docs` and `/api-docs/openapi.*` locations. JSON/YAML source size and YAML alias expansion are bounded; malformed contracts are tooling telemetry. Discovery and endpoint requests follow zero redirects, and operation paths may not escape the starting origin.

Browser Explorer storage state is reused only in memory by `APIRequestContext`. Credentials, cookies and tokens are not copied into result/evidence metadata.

## API modes

- `off` — no API QA
- `discover` — contract inventory only
- `safe` — guarded `GET`/`HEAD`; default
- `sandbox` — guarded state-changing requests against an explicitly disposable target

```bash
npm run qa -- --url https://example.com --api-mode safe
```

Sandbox requires a double gate:

```bash
npm run qa -- \
  --url https://staging.example.com \
  --api-mode sandbox \
  --confirm-disposable-target
```

Without confirmation the internal `ApiAgent` returns before creating an API request context, so sandbox sends zero requests, including no OpenAPI discovery.

## Safe and sandbox request planning

Required path/query values must come from explicit examples, defaults, enums, or a newly created lifecycle identity. The agent does not invent user IDs or write payloads.

Suspicious state-changing GETs are blocked. Sandbox write bodies must have an explicit OpenAPI example/default/enum. Financial/payment/charge/transfer/payout/withdrawal/deposit, deployment/production, credential/secret/token, webhook/email/SMS/notification families remain permanently blocked even in sandbox, including common plural forms.

Request body values are not serialized into QA events.

## Cleanup-safe lifecycle

A stateful scenario is planned only when mutation can be paired with a known cleanup operation. The common supported shape is:

```text
POST collection
  ↓
bind newly-created ID
  ↓
GET item                optional
  ↓
PATCH item              optional/example-backed
  ↓
GET item                optional
  ↓
DELETE item             mandatory cleanup
  ↓
GET item                optional post-cleanup telemetry
```

The item route must directly match `collection/{id}` and have an executable DELETE. Once an ID is captured, one operation-budget slot is reserved for cleanup; DELETE runs from `finally`, including when a middle GET/PATCH/schema/request step fails.

### Identity discovery

The runner prefers a required identity property from the successful create JSON response. M4.6 also supports `Location`-only creation when the OpenAPI success response explicitly declares a `Location` header.

A Location identity is accepted only when:

- the response contract declared `Location`
- the resolved URL remains on the original origin
- its pathname is exactly the collection path plus one resource segment
- that single segment can safely bind the item `{id}` placeholder

Cross-origin or structurally unrelated Location values are rejected. The full Location is not persisted to QA evidence; telemetry records only whether it was present and whether identity came from `body` or `location`.

Cleanup failure is a High assertion. The API summary exposes lifecycle planned/completed counts, stateful operations, cleanup attempts and cleanup failures.

## Contract validation

Executed operations are checked for HTTP 5xx, undeclared status, wrong JSON content type, invalid JSON, request failures and response schema violations. OpenAPI 3.1 schemas are validated with bounded Ajv draft-2020-12 support, including nested/recursive local `#/components/schemas/...` references rewritten into a standalone `$defs` graph. Remote `$ref` retrieval remains disabled.

## Browser ↔ network ↔ API causal correlation

A causal chain begins only when a browser 4xx/5xx occurs within three seconds after a real browser action. Action + failed request is medium confidence. It becomes high confidence only when a structured API assertion independently matches the same method and OpenAPI path. Immediate UI signals and interaction screenshots can enrich the existing finding without creating a duplicate correlation bug.

## M4.6 semantic state oracle

The semantic layer targets a different failure mode: **HTTP 2xx and schema-valid data, but the UI shows stale or inconsistent state**.

It is enabled by default when API mode is `safe` or `sandbox`; disable it with:

```bash
npm run qa -- --url https://example.com --no-semantic-state
```

The first semantic oracle is deliberately conservative:

1. execute bounded safe OpenAPI GETs only
2. extract bounded non-sensitive scalar facts from successful JSON responses
3. revisit already explored same-origin pages using the same in-memory browser storage state
4. inspect visible `input`, `textarea` and `select` controls
5. require a canonical identity match between the API leaf key and UI `name`/`id`/label/ARIA/placeholder
6. require API path and UI page/form-action scope to overlap
7. skip an API key when multiple endpoints returned different values for that key
8. emit a Medium mismatch only when a scoped UI control exists but none contains the API value

This prevents the agent from assuming every API field must be visibly rendered.

### Privacy boundary

Semantic comparison never writes raw API/UI values to `events.json` or `result.json`. Each run creates a random in-memory salt and compares truncated SHA-256 hashes. Evidence records field keys, API paths, match/mismatch state and `valuesHashed: true`, but not the compared values.

Sensitive API keys and controls are excluded, including password/passcode, token/secret/credential, authentication/session/OTP/CSRF/API-key/private-key, card/CVV/CVC/IBAN/routing/bank/account-number signals. Low-signal identifiers/timestamps are also excluded from semantic comparison.

## Validation coverage

The suite now verifies:

- JSON/YAML safe OpenAPI QA and zero redirects
- sandbox zero-request refusal without disposable confirmation
- permanent financial/external-side-effect blocking
- full resource lifecycle and cleanup after a forced PATCH 500
- safe body identity and declared same-origin Location identity
- cross-origin Location rejection with no external cleanup request
- semantic API/UI mismatch reporting
- semantic match producing no finding
- raw profile/token/card values absent from semantic event serialization

M4.6 semantic state and Location identity passed CI #85 and CI #88 respectively.

## Current limitations

- lifecycle matching focuses on the common `collection` → `collection/{id}` shape
- arbitrary request-body synthesis is intentionally not enabled
- semantic comparison currently targets explicit form controls, not arbitrary prose/cards/tables
- semantic mismatch confidence is currently Medium; higher confidence will require action-specific before/after state evidence
- post-cleanup soft-delete behavior is telemetry rather than a universal defect
- GraphQL discovery, remote `$ref`, distributed workers and richer semantic models remain later work
