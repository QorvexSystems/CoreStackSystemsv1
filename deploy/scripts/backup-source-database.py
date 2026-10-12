#!/usr/bin/env python3
"""Create a private, checksummed logical backup of ALLPA's Supabase source."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import unquote, urlparse


PROJECT_REF = "ofiajrknxhtquctgrysr"
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPOSITORY_ROOT / ".env"
BACKUP_PARENT = Path("/opt/corestack/backups/allpa-source")
POSTGRES_IMAGE = "postgres:17-alpine"


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


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_container(environment_file: Path, backup_dir: Path, command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "docker", "run", "--rm", "--network", "host",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "--env-file", str(environment_file),
            "--volume", f"{backup_dir}:/backup",
            POSTGRES_IMAGE,
            *command,
        ],
        text=True,
        capture_output=capture,
        check=True,
    )


def main() -> None:
    if ENV_FILE.stat().st_mode & 0o077:
        raise SystemExit(".env debe conservar permisos 600 antes del respaldo.")

    values = read_dotenv(ENV_FILE)
    parsed = urlparse(values.get("DIRECT_URL", ""))
    if parsed.scheme not in {"postgres", "postgresql"} or PROJECT_REF not in values.get("DIRECT_URL", ""):
        raise SystemExit("DIRECT_URL no corresponde al origen esperado.")
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

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    BACKUP_PARENT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(BACKUP_PARENT, 0o700)
    backup_dir = BACKUP_PARENT / timestamp
    backup_dir.mkdir(mode=0o700)

    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="allpa-pg-", delete=False) as file:
        environment_file = Path(file.name)
        os.chmod(environment_file, 0o600)
        for key, value in safe_environment.items():
            file.write(f"{key}={value}\n")

    try:
        run_container(
            environment_file,
            backup_dir,
            [
                "sh", "-eu", "-c",
                "umask 077; exec pg_dump --format=custom --compress=9 --no-owner --no-privileges --schema=public --file=/backup/allpa-public.dump",
            ],
        )
        run_container(
            environment_file,
            backup_dir,
            [
                "sh", "-eu", "-c",
                "umask 077; exec pg_dump --schema-only --no-owner --no-privileges --schema=public --file=/backup/allpa-public-schema.sql",
            ],
        )
        archive_list = run_container(
            environment_file,
            backup_dir,
            ["pg_restore", "--list", "/backup/allpa-public.dump"],
            capture=True,
        ).stdout
    finally:
        environment_file.unlink(missing_ok=True)

    dump_file = backup_dir / "allpa-public.dump"
    schema_file = backup_dir / "allpa-public-schema.sql"
    manifest_file = backup_dir / "allpa-public.manifest"
    manifest_file.write_text(archive_list, encoding="utf-8")

    checksums = {
        dump_file.name: sha256(dump_file),
        schema_file.name: sha256(schema_file),
        manifest_file.name: sha256(manifest_file),
    }
    checksum_file = backup_dir / "SHA256SUMS"
    checksum_file.write_text(
        "".join(f"{digest}  {name}\n" for name, digest in checksums.items()),
        encoding="utf-8",
    )
    metadata_file = backup_dir / "BACKUP_INFO"
    metadata_file.write_text(
        "\n".join(
            [
                "status=complete",
                f"created_at_utc={timestamp}",
                f"source_project={PROJECT_REF}",
                "source_schema=public",
                f"archive_bytes={dump_file.stat().st_size}",
                f"postgres_image={POSTGRES_IMAGE}",
                "owner_and_privileges_excluded=true",
                "",
            ]
        ),
        encoding="utf-8",
    )

    for path in backup_dir.iterdir():
        path.chmod(0o600)

    print(f"backup_dir={backup_dir}")
    print(f"archive_bytes={dump_file.stat().st_size}")
    print(f"archive_sha256={checksums[dump_file.name]}")
    print("status=complete")


if __name__ == "__main__":
    main()
