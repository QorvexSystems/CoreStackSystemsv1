#!/usr/bin/env python3
"""Restore the verified ALLPA archive into its empty VM3 production database."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile


DATABASE_HOST = "10.0.0.4"
DATABASE_PORT = "5432"
DATABASE_NAME = "allpa_production"
MIGRATOR_ROLE = "allpa_migrator"
RUNTIME_ROLE = "allpa_runtime"
BACKUP_DIR = Path("/opt/corestack/backups/allpa-source/20260929T033557Z")
ARCHIVE = BACKUP_DIR / "allpa-public.dump"
EXPECTED_ARCHIVE_SHA256 = "a7f1609652c83a193dc09a5526ddc01c00ea6a211628c4e0588edc2102ade614"
SECRETS_DIR = Path("/opt/corestack/apps/allpa/secrets")
POSTGRES_IMAGE = "postgres:17-alpine"


def read_password(path: Path) -> str:
    if path.stat().st_mode & 0o077:
        raise SystemExit(f"Permisos inseguros en {path}.")
    password = path.read_text(encoding="utf-8").strip()
    if not 48 <= len(password) <= 128 or not all(char.isalnum() or char in "_-" for char in password):
        raise SystemExit(f"Formato de credencial inesperado en {path}.")
    return password


def archive_sha256() -> str:
    digest = hashlib.sha256()
    with ARCHIVE.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def environment_file(role: str, password: str, database: str = DATABASE_NAME, sslmode: str = "require") -> Path:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="allpa-target-", delete=False) as file:
        path = Path(file.name)
        os.chmod(path, 0o600)
        values = {
            "PGHOST": DATABASE_HOST,
            "PGPORT": DATABASE_PORT,
            "PGUSER": role,
            "PGPASSWORD": password,
            "PGDATABASE": database,
            "PGSSLMODE": sslmode,
            "PGCONNECT_TIMEOUT": "10",
        }
        for key, value in values.items():
            file.write(f"{key}={value}\n")
    return path


def docker_postgres(env_file: Path, command: list[str], *, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [
            "docker", "run", "--rm", "--interactive", "--network", "host",
            "--env-file", str(env_file),
            "--volume", f"{BACKUP_DIR}:/backup:ro",
            POSTGRES_IMAGE,
            *command,
        ],
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        if result.stderr:
            print(result.stderr, end="", file=os.sys.stderr)
        raise SystemExit(result.returncode)
    return result


def psql(env_file: Path, sql: str, *, tuples_only: bool = False, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = ["psql", "-X", "--no-psqlrc", "-v", "ON_ERROR_STOP=1"]
    if tuples_only:
        command.extend(["--tuples-only", "--no-align"])
    return docker_postgres(env_file, command, input_text=sql, check=check)


def main() -> None:
    if archive_sha256() != EXPECTED_ARCHIVE_SHA256:
        raise SystemExit("El hash del respaldo no coincide; se rechazo la restauracion.")

    migrator_password = read_password(SECRETS_DIR / "db-migrator.password")
    runtime_password = read_password(SECRETS_DIR / "db-runtime.password")
    migrator_env = environment_file(MIGRATOR_ROLE, migrator_password)
    runtime_env = environment_file(RUNTIME_ROLE, runtime_password)
    runtime_no_tls_env = environment_file(RUNTIME_ROLE, runtime_password, sslmode="disable")
    runtime_wrong_db_env = environment_file(RUNTIME_ROLE, runtime_password, database="postgres")

    try:
        preflight = psql(
            migrator_env,
            """
BEGIN READ ONLY;
SELECT current_database(), current_user,
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
       (SELECT count(*) FROM pg_tables WHERE schemaname = 'public');
COMMIT;
""",
            tuples_only=True,
        ).stdout.strip().splitlines()
        values = next((line for line in preflight if "|" in line), "").split("|")
        empty_target = values == [DATABASE_NAME, MIGRATOR_ROLE, "t", "0"]
        restored_target = values == [DATABASE_NAME, MIGRATOR_ROLE, "t", "42"]
        if not empty_target and not restored_target:
            raise SystemExit(f"Preflight inesperado: {'|'.join(values)}")

        runtime_preflight = psql(
            runtime_env,
            "SELECT current_database(), current_user, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid());",
            tuples_only=True,
        ).stdout.strip()
        if runtime_preflight != f"{DATABASE_NAME}|{RUNTIME_ROLE}|t":
            raise SystemExit("El usuario runtime no entro al destino esperado mediante TLS.")

        if psql(runtime_no_tls_env, "SELECT 1;", check=False).returncode == 0:
            raise SystemExit("La conexion sin TLS fue aceptada inesperadamente.")
        if psql(runtime_wrong_db_env, "SELECT 1;", check=False).returncode == 0:
            raise SystemExit("El rol runtime pudo entrar a una base fuera de ALLPA.")

        if empty_target:
            psql(migrator_env, "DROP SCHEMA public CASCADE;")
            docker_postgres(
                migrator_env,
                [
                    "pg_restore", "--exit-on-error", "--single-transaction",
                    "--no-owner", "--no-privileges", "--dbname", DATABASE_NAME,
                    "/backup/allpa-public.dump",
                ],
            )

            grants_sql = """
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO allpa_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO allpa_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO allpa_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO allpa_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE allpa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO allpa_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE allpa_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO allpa_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE allpa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO allpa_runtime;
COMMIT;
"""
            psql(migrator_env, grants_sql)

        verification = psql(
            migrator_env,
            """
BEGIN READ ONLY;
SELECT (SELECT count(*) FROM "Tenant"),
       (SELECT count(*) FROM "User"),
       (SELECT count(*) FROM "Product"),
       (SELECT count(*) FROM "InventoryMovement"),
       (SELECT count(*) FROM "Invoice"),
       (SELECT count(*) FROM "SalesOrder"),
       (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
       (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner='allpa_migrator');
COMMIT;
""",
            tuples_only=True,
        ).stdout.strip().splitlines()
        counts = next((line for line in verification if "|" in line), "")
        if counts != "2|6|726|726|17|19|33|42":
            raise SystemExit(f"Los conteos restaurados no coinciden: {counts}")

        runtime_verification = psql(
            runtime_env,
            """
BEGIN READ ONLY;
SELECT count(*) FROM "Product";
SELECT has_schema_privilege(current_user, 'public', 'USAGE'),
       has_schema_privilege(current_user, 'public', 'CREATE'),
       has_table_privilege(current_user, 'public."Product"', 'SELECT,INSERT,UPDATE,DELETE');
COMMIT;
""",
            tuples_only=True,
        ).stdout.strip().splitlines()
        runtime_lines = [line for line in runtime_verification if line and line not in {"BEGIN", "COMMIT"}]
        if runtime_lines != ["726", "t|f|t"]:
            raise SystemExit(f"Privilegios runtime inesperados: {runtime_lines}")

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        report = BACKUP_DIR / "TARGET_RESTORE_INFO"
        report.write_text(
            "\n".join(
                [
                    "status=verified",
                    f"restored_at_utc={timestamp}",
                    f"target={DATABASE_HOST}:{DATABASE_PORT}/{DATABASE_NAME}",
                    f"archive_sha256={EXPECTED_ARCHIVE_SHA256}",
                    "counts=2|6|726|726|17|19|33|42",
                    "tls_required=true",
                    "runtime_cross_database_denied=true",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        report.chmod(0o600)

        print("target_counts=2|6|726|726|17|19|33|42")
        print("runtime_privileges=verified")
        print("tls_and_scope=verified")
        print("ALLPA_DATABASE_RESTORED")
    finally:
        for path in (migrator_env, runtime_env, runtime_no_tls_env, runtime_wrong_db_env):
            path.unlink(missing_ok=True)
        migrator_password = ""
        runtime_password = ""


if __name__ == "__main__":
    main()
