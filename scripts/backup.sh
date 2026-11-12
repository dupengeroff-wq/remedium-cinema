#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
: "${DATABASE_DIRECT_URL:?Set DATABASE_DIRECT_URL}"
: "${VERIFY_DATABASE_URL:?Set a fresh disposable PostgreSQL database URL}"
: "${BACKUP_AGE_RECIPIENT:?Set the public age recipient}"
: "${BACKUP_BUCKET_URI:?Set the private s3://bucket/prefix}"
[[ "$BACKUP_BUCKET_URI" == s3://* && "$VERIFY_DATABASE_URL" != "$DATABASE_DIRECT_URL" ]]
umask 077
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
name="remedium-$stamp.dump.age"
pg_dump --format=custom --no-owner --no-privileges --file="$work/site.dump" --dbname="$DATABASE_DIRECT_URL"
if [[ "$(psql "$VERIFY_DATABASE_URL" -XAtqc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" != 0 ]]; then
  echo 'Verification database must be empty' >&2
  exit 1
fi
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$VERIFY_DATABASE_URL" "$work/site.dump"
psql "$VERIFY_DATABASE_URL" -X --set=ON_ERROR_STOP=on --file=scripts/verify-restore.sql
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$work/$name" "$work/site.dump"
aws_args=()
if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then aws_args+=(--endpoint-url "$BACKUP_S3_ENDPOINT"); fi
aws "${aws_args[@]}" s3 cp --only-show-errors "$work/$name" "${BACKUP_BUCKET_URI%/}/$name"
echo "Verified and uploaded $name"
