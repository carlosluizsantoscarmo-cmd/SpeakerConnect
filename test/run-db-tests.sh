#!/bin/sh
# Cria um banco limpo, aplica o schema.sql DUAS vezes (para provar que pode rodar de novo) e roda os testes.
set -e
H=${PGHOST:-/tmp/pgtest}; P=${PGPORT:-5544}
cd "$(dirname "$0")/.."
psql -q -h $H -p $P -U postgres -c "drop database if exists sc_test" -c "create database sc_test" >/dev/null
for f in test/fake-supabase.sql supabase/schema.sql supabase/schema.sql test/db.test.sql; do
  psql -q -X -v ON_ERROR_STOP=1 -h $H -p $P -U postgres -d sc_test -f $f 2>&1 | grep -v "^NOTICE\|does not exist, skipping\|already exists, skipping" || true
done
