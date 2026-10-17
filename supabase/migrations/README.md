# Migrations

The SQL files in this directory are the **source of truth** for the database
schema. They are applied in filename order (the `YYYYMMDDhhmmss_` prefix sorts
chronologically), one entry per file, to the Supabase project named by
`SUPABASE_PROJECT_REF`.

## How a migration is applied

Scripts cannot call the Composio MCP and there is no Supabase PAT, so the
applier is the agent, not a script:

1. From the **repo root**, run `npm run migrations:check` (or
   `node scripts/apply-migration.ts`) to print the JSON manifest:
   `[{ name, idempotencyKey, sql }]`. `--check` validates without emitting.
   The script resolves the migrations directory from the current working
   directory, so running it from elsewhere reports the directory missing.
2. **Before applying, list what is already recorded**:
   `select name from supabase_migrations.schema_migrations;`
   **Skip any manifest entry whose file name already appears there.**
   This step is load-bearing: measured on this project, re-applying the same
   migration under the same `idempotency_key` is **not rejected** by the
   applier — the SQL simply runs again. The key deduplicates nothing; the
   history check is the only thing that prevents a re-apply.
3. The agent applies each pending entry through the Composio MCP
   (`SUPABASE_APPLY_A_MIGRATION`) with `ref` = the project ref, `name` = the
   file name, `query` = the file's SQL, and `idempotencyKey` = the manifest key.
   The project ref lives in `.env.local` as `SUPABASE_PROJECT_REF`.
4. The agent then **verifies by querying the catalogue** —
   `information_schema` / `pg_catalog` / `pg_policies` — because the apply
   response body is not trustworthy (measured: it reports success with an
   empty payload). An apply is done when the catalogue says the object
   exists, not when the tool says "success".

## Rules

- Filename must match `YYYYMMDDhhmmss_snake_case.sql`. `--check` enforces it.
- A file that looks like a migration but does not end in `.sql` fails the
  check — a timestamp prefix is treated as intent. Note the corners: a prefix
  one digit short of fourteen, or a bare fourteen-digit name with no `_name`
  part, is silently ignored rather than flagged.
- Never edit an applied migration; add a new file instead.
- Guard policy and extension DDL in `DO $$ … $$` blocks against
  `pg_catalog`: the applier can reject `IF NOT EXISTS` policy DDL with
  SQLSTATE 42601.
- `supabase/config.toml` exists so a future PAT (or a local
  `supabase start`) runs these same files; nothing in the harness reads it.
