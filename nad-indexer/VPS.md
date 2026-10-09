# NadBounty self-hosted indexer

The testnet ledger runs as a separate Compose project under `/home/openclaw/nadbounty-indexer` on the existing OpenClaw VPS. Source release directories and the `current` symlink allow controlled updates; the PostgreSQL volume survives image changes. Do not run `compose down -v`.

Services: PostgreSQL17.5, Hasura2.43.0 and Envio3.14.0 on Node24.3.0. Combined configured memory limit1540MB; indexer limit900MB. Database is private to its Docker network. Indexer health/metrics bind only to `127.0.0.1:9899`. The existing Caddy serves only the public read-only GraphQL path; console and metadata are not exposed. API admin and database secrets are generated on the server, mode0600. No transaction-signing key is required.

`ENVIO_API_TOKEN` is a separate HyperSync credential required for self-hosted access, unlike Envio Cloud's managed credentials. Copy it securely into the server's private `.env`; never put it in this repository or a browser bundle.

Operations from `current`:

```sh
docker compose -f compose.vps.yaml ps
docker compose -f compose.vps.yaml logs --tail 100 indexer
curl -f http://127.0.0.1:9899/healthz
curl -f http://127.0.0.1:9899/metrics
```

Backups use `backup.vps.sh`, PostgreSQL `pg_dump` and gzip integrity verification, private file permissions and seven-day retention. These local backups cover an application or database failure; they do not provide recovery from loss of the whole VPS. The ledger can also be reconstructed from complete chain history. Preserve source ranges and current-owner semantics when changing hosting.

Before calling migration complete, confirm all three chains caught up, compare bounty/identity/mirror entities with the known Envio Cloud readback, verify public GraphQL cannot mutate or access admin metadata, and exercise a restart with the same database. Mainnet needs its own explicit chain143 deployments/configuration; this testnet stack is not a mainnet indexer.
