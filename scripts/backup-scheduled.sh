#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
: "${BACKUP_ENV_FILE:?Set BACKUP_ENV_FILE to your private backup settings file}"
set -a
source "$BACKUP_ENV_FILE"
set +a

# Use an isolated restore target and remove it at the end of the job.
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
container="$(docker run --detach --rm --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD \
  --env POSTGRES_DB=cinema_restore_check postgres:17)"
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
for attempt in {1..45}; do
  if docker exec "$container" pg_isready --host 127.0.0.1 --username postgres --dbname cinema_restore_check >/dev/null 2>&1; then break; fi
  if [[ "$attempt" -eq 45 ]]; then echo 'Restore target did not start' >&2; exit 1; fi
  sleep 2
done
address="$(docker port "$container" 5432/tcp)"
export VERIFY_DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@$address/cinema_restore_check"
unset POSTGRES_PASSWORD
bash scripts/backup.sh
