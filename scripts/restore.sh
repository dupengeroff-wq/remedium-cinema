#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?Set the URL of a fresh database}"
: "${RESTORE_AGE_IDENTITY:?Set the path to your private age key}"
[[ "$#" -eq 1 && -f "$1" ]] || { echo 'Pass an encrypted .dump.age file' >&2; exit 2; }
script_dir="$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "$(psql "$RESTORE_DATABASE_URL" -XAtqc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" != 0 ]]; then
  echo 'Restore requires an empty database. Existing data was not touched.' >&2
  exit 1
fi
umask 077
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
age --decrypt --identity "$RESTORE_AGE_IDENTITY" --output "$work/site.dump" "$1"
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" "$work/site.dump"
psql "$RESTORE_DATABASE_URL" -X --set=ON_ERROR_STOP=on --file="$script_dir/verify-restore.sql"
psql "$RESTORE_DATABASE_URL" -X --set=ON_ERROR_STOP=on --command='UPDATE auth_sessions SET revoked_at=now() WHERE revoked_at IS NULL;'
echo 'Restored. Users must sign in again.'
