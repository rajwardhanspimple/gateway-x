#!/usr/bin/env bash
# Apply the RageStar database schema to Supabase.
#
#   export DATABASE_URL='postgresql://postgres:<DB-PASSWORD>@db.vxzpiipnsfrnsrrgxdug.supabase.co:5432/postgres'
#   ./scripts/apply-schema.sh            # schema only
#   ./scripts/apply-schema.sh --seed     # schema + the optional example upstream
#
# No psql? Just paste supabase/schema.sql into the Supabase SQL editor.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set."
  echo "Find it in: Supabase dashboard -> Project settings -> Database -> Connection string -> URI"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install postgresql-client, or paste supabase/schema.sql into the SQL editor."
  exit 1
fi

echo "==> applying supabase/schema.sql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/schema.sql"

if [ "${1:-}" = "--seed" ]; then
  echo "==> applying supabase/seed.sql"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/seed.sql"
fi

echo "==> done"
