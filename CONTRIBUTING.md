# Contributing

## Before opening a pull request

```bash
npm run check    # lint + typecheck + tests + build
```

CI runs exactly this. The test suite needs no Postgres and no Ollama — the
repositories are faked and the HTTP tests bind an ephemeral port — so a clean
checkout can run it immediately.

## Invariants worth knowing first

These are load-bearing. Breaking one of them usually does not fail loudly; it
makes search quietly return nothing.

- **Two vector spaces, never mixed.** 768-d `nomic-embed-text` for thoughts,
  1024-d `bge-m3` for document chunks and tree nodes. Cross-corpus merging
  compares the composite rank — a dimensionless number each corpus computes in
  its own space — and never a cosine from one space against the other. The
  dimension asserts exist because a wrong-space query vector returns zero rows
  rather than an error.
- **This repository owns the memory tables' DDL.** `migrations/` is the source
  of truth, every migration is idempotent, and a change to the vault tables
  updates `src/db/schema.ts` in the same commit. See
  [migrations/README.md](migrations/README.md).
- **The dedup thresholds are a cross-writer contract.** 0.85 within 48h skips;
  0.80 outside it supersedes up to three. Other processes write the same
  tables against the same numbers. They are not tuning knobs.
- **The text output shapes are frozen.** Hook scripts and other consumers parse
  them by pattern. Change a formatter only alongside every consumer.
- **No tool takes an agent id.** The credential carries the namespace.
  `tests/tools/surface.test.ts` fails the build if `agent_id` appears in any
  tool schema.
- **Deployment identity is never defaulted.** The database name and stdio
  namespace are required; the OAuth issuer and audience ship as `example.com`
  placeholders that are refused if OAuth is enabled. A default you cannot see
  in your config file is a default you cannot audit.

## Conventions

- ESM, TypeScript strict, `NodeNext`, no `any`.
- One file per tool under `src/tools/`; schemas live in the
  `MEMORY_TOOL_SCHEMAS` registry in `shared.ts`, which the build and the
  parity test both read.
- Secrets only via `SecretRef` (`{ env }` / `{ file }`) — never in TOML, never
  logged.
- Logs go to fd 2 only; stdout belongs to the stdio protocol.
- Zod 4: input-side defaults on nested objects are `.prefault({})`, not
  `.default({})`.

## Reporting bugs

Open an issue with the config shape (secrets redacted), what you expected, and
what happened. For anything security-relevant, see [SECURITY.md](SECURITY.md)
instead.
