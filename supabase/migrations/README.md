# Migrations

The SQL files in this directory are the **source of truth** for the database
schema. They are applied in filename order (the `YYYYMMDDhhmmss_` prefix sorts
chronologically), one entry per file, to the Supabase project named by
`SUPABASE_PROJECT_REF`.

## How a migration is applied

Scripts cannot call the Composio MCP and there is no Supabase PAT, so the
applier is the agent, not a script:

1. `npx tsx scripts/apply-migration.ts` prints the JSON manifest:
   `[{ name, idempotencyKey, sql }]`. `--check` validates without emitting.
2. The agent applies each entry through the Composio MCP
   (`SUPABASE_APPLY_A_MIGRATION`) with `ref` = the project ref, `name` = the
   file name, `query` = the file's SQL, and `idempotencyKey` = the manifest
   key, so the same file can never be applied twice under that key.
3. The agent then **verifies by querying the catalogue** —
   `information_schema` / `pg_catalog` / `pg_policies` — because the apply
   response body is not trustworthy. An apply is done when the catalogue says
   the object exists, not when the tool says "success".

## Rules

- Filename must match `YYYYMMDDhhmmss_snake_case.sql`. `--check` enforces it.
- A file that looks like a migration but does not end in `.sql` fails the
  check — a timestamp prefix is treated as intent.
- Never edit an applied migration; add a new file instead.
- Guard policy and extension DDL in `DO $$ … $$` blocks against
  `pg_catalog`: the applier can reject `IF NOT EXISTS` policy DDL with
  SQLSTATE 42601.
- `supabase/config.toml` exists so a future PAT (or a local
  `supabase start`) runs these same files; nothing in the harness reads it.
