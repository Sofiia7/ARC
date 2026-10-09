#!/bin/bash
set -euo pipefail
base=/home/openclaw/nadbounty-indexer
cd "$base/current"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/backups/nadbounty-$stamp.sql.gz"
docker compose -f compose.vps.yaml exec -T nad-postgres pg_dump -U nadbounty -d nadbounty | gzip > "$target.tmp"
test -s "$target.tmp"
gzip -t "$target.tmp"
mv "$target.tmp" "$target"
find "$base/backups" -maxdepth 1 -type f -name 'nadbounty-*.sql.gz' -mtime +7 -delete

