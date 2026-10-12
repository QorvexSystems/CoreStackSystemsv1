#!/usr/bin/env python3
"""Inspect the ALLPA source database without exposing its connection string."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import unquote, urlparse


PROJECT_REF = "ofiajrknxhtquctgrysr"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPOSITORY_ROOT / ".env"
SCHEMA_FILE = REPOSITORY_ROOT / "packages/database/prisma/schema.prisma"
MIGRATIONS_DIR = REPOSITORY_ROOT / "packages/database/prisma/migrations"


def read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", action="store_true")
    args = parser.parse_args()

    values = read_dotenv(ENV_FILE)
    connection_url = values.get("DIRECT_URL", "")
    parsed = urlparse(connection_url)

    if parsed.scheme not in {"postgres", "postgresql"}:
        raise SystemExit("DIRECT_URL no es una URI PostgreSQL valida.")
    if PROJECT_REF not in connection_url:
        raise SystemExit("DIRECT_URL no corresponde al proyecto esperado.")
    if not all((parsed.hostname, parsed.username, parsed.password, parsed.path.lstrip("/"))):
        raise SystemExit("DIRECT_URL no contiene todos los parametros requeridos.")

    safe_environment = {
        "PGHOST": parsed.hostname or "",
        "PGPORT": str(parsed.port or 5432),
        "PGUSER": unquote(parsed.username or ""),
        "PGPASSWORD": unquote(parsed.password or ""),
        "PGDATABASE": parsed.path.lstrip("/"),
        "PGSSLMODE": "require",
        "PGCONNECT_TIMEOUT": "10",
    }

    sql = r'''
BEGIN READ ONLY;
SELECT current_database() AS database_name,
       current_user AS connected_user,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only;
SELECT count(*) AS public_tables
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT to_regclass('public."Tenant"') IS NOT NULL AS has_tenant_table,
       to_regclass('public."Product"') IS NOT NULL AS has_product_table,
       to_regclass('public._prisma_migrations') IS NOT NULL AS has_prisma_history;
COMMIT;
'''

    if args.inventory:
        model_names = [
            line.split()[1]
            for line in SCHEMA_FILE.read_text(encoding="utf-8-sig").splitlines()
            if line.startswith("model ")
        ]
        count_queries = "\nUNION ALL\n".join(
            f'SELECT \'{name}\' AS entity, count(*) AS rows FROM "{name}"'
            for name in model_names
        )
        migrations = sorted(
            path.name for path in MIGRATIONS_DIR.iterdir()
            if path.is_dir() and (path / "migration.sql").is_file()
        )
        migration_values = ",\n".join(
            f"('{migration}')" for migration in migrations
        )
        sql = f'''
BEGIN READ ONLY;

SELECT name, slug, status,
       (SELECT count(*) FROM "Membership" m WHERE m."tenantId" = t.id) AS memberships,
       (SELECT count(*) FROM "Product" p WHERE p."tenantId" = t.id) AS products,
       (SELECT count(*) FROM "Customer" c WHERE c."tenantId" = t.id) AS customers,
       (SELECT count(*) FROM "Invoice" i WHERE i."tenantId" = t.id) AS invoices,
       (SELECT count(*) FROM "SalesOrder" s WHERE s."tenantId" = t.id) AS sales_orders
FROM "Tenant" t
ORDER BY slug;

SELECT * FROM (
{count_queries}
) inventory
ORDER BY entity;

SELECT status, count(*) AS users
FROM "User"
GROUP BY status
ORDER BY status;

SELECT count(*) FILTER (WHERE "imageUrl" IS NOT NULL AND btrim("imageUrl") <> '') AS products_with_image,
       count(*) FILTER (WHERE "imageUrl" IS NULL OR btrim("imageUrl") = '') AS products_without_image
FROM "Product";

SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS successful_migrations,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back_migrations,
       max(finished_at) AS latest_finished_at
FROM _prisma_migrations;

SELECT failed.migration_name,
       failed.rolled_back_at,
       EXISTS (
         SELECT 1
         FROM _prisma_migrations applied
         WHERE applied.migration_name = failed.migration_name
           AND applied.finished_at IS NOT NULL
           AND applied.rolled_back_at IS NULL
       ) AS later_applied_successfully
FROM _prisma_migrations failed
WHERE failed.rolled_back_at IS NOT NULL
ORDER BY failed.rolled_back_at;

WITH repository(migration_name) AS (
  VALUES
{migration_values}
), source AS (
  SELECT migration_name
  FROM _prisma_migrations
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
)
SELECT 'pending_on_source' AS difference, repository.migration_name
FROM repository
LEFT JOIN source USING (migration_name)
WHERE source.migration_name IS NULL
UNION ALL
SELECT 'source_not_in_repository', source.migration_name
FROM source
LEFT JOIN repository USING (migration_name)
WHERE repository.migration_name IS NULL
ORDER BY difference, migration_name;

COMMIT;
'''

    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="allpa-pg-", delete=False) as file:
        temporary_path = Path(file.name)
        os.chmod(temporary_path, 0o600)
        for key, value in safe_environment.items():
            file.write(f"{key}={value}\n")

    try:
        result = subprocess.run(
            [
                "docker", "run", "--rm", "--interactive", "--network", "host",
                "--env-file", str(temporary_path),
                "postgres:17-alpine", "psql", "-X", "--no-psqlrc",
                "-v", "ON_ERROR_STOP=1",
            ],
            input=sql,
            text=True,
            capture_output=True,
            check=False,
        )
    finally:
        temporary_path.unlink(missing_ok=True)

    if result.stdout:
        print(result.stdout, end="")
    if result.returncode:
        if result.stderr:
            print(result.stderr, end="", file=os.sys.stderr)
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
