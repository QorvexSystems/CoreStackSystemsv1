# ALLPA deployment

Target topology:

- VM1 (`10.0.0.2`): HTTPS reverse proxy, `allpa.corestack-systems.com`.
- VM2 (`10.0.0.3`): ALLPA web `3002`, API `4002`, dedicated Docker network.
- VM3 (`10.0.0.4`): dedicated PostgreSQL database and role, pending source migration.
- API public base URL: `https://allpa-api.corestack-systems.com`.

## Current preparation

`Dockerfile` builds and type-checks this checkout. `deploy/docker/compose.production.yml`
provides independent ALLPA containers, with resource limits, health checks and
read-only filesystems. `deploy/nginx/allpa-production.conf` is the VM1 HTTPS
configuration; its certificate must exist before installation.

No production database has been created or migrated. Existing ALLPA data must be
located and inventoried first. Preserve users and password hashes during migration.
Do not run the development seed: it deletes data and creates fictitious records.

## Required deployment inputs

1. Source database or backup, source PostgreSQL version and installed migrations.
2. Confirm whether the source contains ALLPA alone or multiple companies.
3. Inventory external files/storage references and retain or migrate those assets.
4. Create a restricted ALLPA database role and database on VM3. Use independent
   credentials and PostgreSQL TLS. Preserve the existing ERP and fiscal databases.
5. Store the target connection URLs and a new JWT secret in
   `/opt/corestack/apps/allpa/secrets/api.env` with restrictive permissions.
   Set `NODE_ENV=production`, `API_PORT=4000`,
   `CORS_ORIGIN=https://allpa.corestack-systems.com`, and `TRUST_PROXY=1`.
   Configure storage/email only when required by the actual ALLPA services.
6. Copy `deploy/env/production.example` to
   `/opt/corestack/apps/allpa/secrets/deploy.env`; set a unique image tag.
7. Allow VM1 to reach VM2 ports 3002 and 4002 through the existing firewall policy,
   checking Docker forwarding rules as well as host rules.
8. Point the ALLPA DNS record at VM1 following the existing Cloudflare setup,
   obtain its TLS certificate, install the Nginx configuration and test before reload.

## Build

From the repository root:

```bash
docker compose --env-file deploy/env/production.example \
  -f deploy/docker/compose.production.yml build
```

## Migration and launch order

- Take a consistent source backup with a checksum and keep the source available.
- Restore into the isolated ALLPA target, never into RIVNU.
- Compare record counts, tenant identity, memberships, inventory and balances.
- Inspect migration history before applying this checkout's outstanding migrations.
- Agree the source write-freeze/cutover when the current system is in use.
- Start ALLPA using the prepared production environment file.
- Verify container health, HTTPS, login, tenant access, dashboard and representative
  read operations; check storage-backed images and documents.
- Confirm backup scheduling for the new database and document rollback to the source.

Administrative operations on VM1 and VM3 currently require interactive sudo.
Do not put passwords in command arguments or commit environment files.
