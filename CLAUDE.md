# CLAUDE.md - agent-memory

Standalone MCP server (protocol 2026-07-28 + legacy serving) over the shared
memory Postgres.

## Invariants (load-bearing; break these and search silently returns nothing)

- **Two vector spaces, never mixed.** 768-d nomic for thoughts/patterns,
  1024-d bge-m3 for chunks/tree nodes. The merge compares composite rank only.
- **This repo owns the memory tables' DDL.** `migrations/` is the source of
  truth (idempotent, adopt-don't-break; see migrations/README.md); a vault
  schema change updates `src/db/schema.ts` in the same commit. No other
  codebase may migrate these tables.
- **Dedup thresholds are a cross-writer contract** (0.85/48h skip, 0.80/3
  supersede) shared with every other process writing `memory_thoughts`. Do not
  tune.
- **Vault timestamps are ISO text**, cast to `timestamptz` on both sides of
  comparisons; `memory_thoughts` uses real timestamptz. The tree node's window
  column is `time_window` (property `window`).
- **The text output shapes are a frozen contract** - the agent-memory plugin's
  hooks grep them. Change formatters only with the plugin in the same commit.

- **Deployment topology is described three times** - `compose.yaml`, the
  systemd unit, and `terraform/` (OpenTofu; see docs/TERRAFORM.md). A change to
  ports, config shape or dependency wiring touches every one that applies. CI
  validates the HCL but cannot detect drift between the three.

## Commands

- `npm run check` - lint + typecheck + tests + build; run before claiming done.
- `npm test` - vitest; `tests/http.test.ts` pins the dual-era gate (a real
  v1 SDK client and a raw 2026-07-28 exchange against a live port).

## Conventions

- ESM, TypeScript strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), NodeNext, no `any`.
- pino logs to fd 2 only (stdout is the stdio protocol).
- One file per tool under `src/tools/`; schemas live in the
  `MEMORY_TOOL_SCHEMAS` registry in `shared.ts` (the build and the parity test
  both read it - keep it that way).
- Secrets only via `SecretRef` (`{ env }`/`{ file }`) - never in TOML, never
  logged (`redactedConfig`).
- Zod 4: input-side defaults on nested objects are `.prefault({})`, not
  `.default({})`.
