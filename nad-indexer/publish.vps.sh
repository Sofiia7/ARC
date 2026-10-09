#!/bin/bash
set -euo pipefail
base=/home/openclaw/nadbounty-indexer
config=/home/openclaw/memepred/deploy/Caddyfile
fragment="$base/current/Caddyfile.vps.fragment"
domain=nadbounty-indexer.89-124-77-59.sslip.io
if ! grep -Fq "$domain" "$config"; then
    umask 077
    cp "$config" "$base/Caddyfile.before-nadbounty"
    cp "$config" "$base/Caddyfile.staged"
    printf '\n' >> "$base/Caddyfile.staged"
    cat "$fragment" >> "$base/Caddyfile.staged"
    docker cp "$base/Caddyfile.staged" deploy-caddy-1:/tmp/nadbounty-Caddyfile
    docker exec deploy-caddy-1 caddy validate --config /tmp/nadbounty-Caddyfile --adapter caddyfile >/dev/null 2>&1
    # Preserve the inode of the bind-mounted config and every existing site.
    printf '\n' >> "$config"
    cat "$fragment" >> "$config"
fi
docker exec deploy-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
echo 'NadBounty GraphQL route validated and reloaded'
