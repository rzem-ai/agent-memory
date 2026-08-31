# Security policy

## Supported versions

The latest release on `main` is the only supported version. This is a
single-maintainer project; fixes land on `main` rather than being backported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting — the **Security** tab on this
repository, then **Report a vulnerability**. That keeps the report private
until a fix exists, and keeps it attached to the code.

Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a week. There is no bounty programme.

## What is in scope

This server authenticates callers and partitions memory between namespaces, so
the interesting failures are:

- **Namespace escape** — any path by which a credential scoped to one agent can
  read, write or delete another agent's memory. Reads span only the
  credential's namespaces, writes land in its first concrete namespace, and
  deletes are guarded in SQL. As of migration `0003` this covers the vault
  corpus (documents, chunks via their document, tree nodes) as well as
  thoughts and KV; vault rows with no owner belong to `[vault] default_owner`.
- **Authentication bypass** — reaching a tool without a valid credential, or
  with one lacking the tool's scope. `/health` and the RFC 9728 metadata
  document are the only unauthenticated routes by design.
- **Token handling** — anything that leaks a static bearer token or a resolved
  secret into logs, error messages or the startup config dump.
- **JWT verification** — issuer or audience assertions that can be bypassed,
  or JWKS handling that accepts an unintended key.
- **Vault path escape** — `memory_read_document` resolving a path outside the
  configured vault root.
- **SQL injection** through any tool input.

## What is not in scope

- `auth.enabled = false`, which grants every caller full scopes. It exists for
  local development and is documented as such; running it on a reachable
  interface is a deployment choice, not a vulnerability.
- The stdio transport's lack of authentication. The OS process boundary is the
  trust boundary there, per the MCP authorisation specification.
- Content of synced documents. Material from the documents corpus is labelled
  `external` precisely so that agents treat it as data rather than
  instructions; an agent that ignores the label is the agent's problem.
- Denial of service through expensive queries against your own database.
