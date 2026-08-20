# M7 Autonomous Fix Agent

M7 turns one verified QA `Finding` into a bounded fix attempt. It is deliberately separated from the QA crawler and from GitHub publishing.

## Safety contract

- `plan` is the default mode and never writes source files.
- `execute` requires an explicit CLI confirmation and a **clean** git checkout.
- execution refuses to start from `main`, `master` or `trunk`.
- every attempt creates `aiqa/fix/<fingerprint>`.
- the model can replace at most 8 bounded text files and must echo each source SHA-256, preventing stale-context writes.
- `.git`, `.github/workflows`, env/secret/credential/private-key paths and lockfiles are denied.
- model-provided verification commands execute with `spawn(..., shell:false)` and an allowlisted program set; shell metacharacters are rejected.
- verification order is targeted tests → original reproduction → full regression.
- any failure rolls source changes back and returns to the original branch.
- M7 does **not** commit, push, merge or write the default branch.

## Provider model

`FixModel` is provider-neutral. `HttpFixModel` accepts a bounded JSON proposal from an HTTPS gateway (loopback HTTP is allowed for local development). The model sees only a small scored set of tracked text files selected from the local checkout.

## CLI

```bash
npm run fix -- \
  --finding .qa-runs/<run>/finding.json \
  --repo /path/to/application \
  --fix-endpoint https://fix-gateway.example/v1/propose \
  --mode plan
```

To apply a proposal locally:

```bash
AIQA_FIX_TOKEN=... npm run fix -- \
  --finding finding.json \
  --repo /path/to/application \
  --fix-endpoint https://fix-gateway.example/v1/propose \
  --mode execute \
  --confirm-write
```

A successful execute result means the fix survived all three gates on an isolated local branch. It is not an approval to merge.
