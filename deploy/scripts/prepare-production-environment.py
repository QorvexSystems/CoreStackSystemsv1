#!/usr/bin/env python3
"""Create private ALLPA production environment files without printing secrets."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import secrets
import subprocess


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ENV = REPOSITORY_ROOT / ".env"
SECRETS_DIR = Path("/opt/corestack/apps/allpa/secrets")
API_ENV = SECRETS_DIR / "api.env"
DEPLOY_ENV = SECRETS_DIR / "deploy.env"


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


def write_env(path: Path, values: dict[str, str]) -> None:
    if path.exists():
        raise SystemExit(f"{path} ya existe; no se sobrescribio.")
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
    path.chmod(0o600)


def main() -> None:
    SECRETS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    SECRETS_DIR.chmod(0o700)
    source = read_dotenv(SOURCE_ENV)
    runtime_password = (SECRETS_DIR / "db-runtime.password").read_text(encoding="utf-8").strip()
    if not 48 <= len(runtime_password) <= 128:
        raise SystemExit("La credencial runtime no cumple el formato esperado.")

    database_url = (
        "postgresql://allpa_runtime:"
        f"{runtime_password}@10.0.0.4:5432/allpa_production?schema=public&sslmode=require"
    )
    api_values = {
        "DATABASE_URL": database_url,
        "DIRECT_URL": database_url,
        "JWT_SECRET": secrets.token_urlsafe(48),
        "JWT_EXPIRES_IN": source.get("JWT_EXPIRES_IN", "8h"),
        "CORS_ORIGIN": "https://allpa.corestack-systems.com",
        "NODE_ENV": "production",
        "TRUST_PROXY": "1",
        "API_PORT": "4000",
        "API_RATE_LIMIT_WINDOW_MS": source.get("API_RATE_LIMIT_WINDOW_MS", "900000"),
        "API_RATE_LIMIT_MAX": source.get("API_RATE_LIMIT_MAX", "600"),
        "AUTH_RATE_LIMIT_WINDOW_MS": source.get("AUTH_RATE_LIMIT_WINDOW_MS", "900000"),
        "AUTH_RATE_LIMIT_MAX": source.get("AUTH_RATE_LIMIT_MAX", "10"),
        "API_JSON_BODY_LIMIT": source.get("API_JSON_BODY_LIMIT", "1mb"),
        "API_FORM_BODY_LIMIT": source.get("API_FORM_BODY_LIMIT", "1mb"),
        "INTERNAL_ALLOWED_IPS": source.get("INTERNAL_ALLOWED_IPS", ""),
        "MOBILE_OCR_PUBLIC_RATE_LIMIT_WINDOW_MS": source.get(
            "MOBILE_OCR_PUBLIC_RATE_LIMIT_WINDOW_MS", "600000"
        ),
        "MOBILE_OCR_PUBLIC_RATE_LIMIT_MAX": source.get("MOBILE_OCR_PUBLIC_RATE_LIMIT_MAX", "30"),
    }
    for key in (
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "SUPABASE_JWKS_URL",
        "RESEND_API_KEY",
        "RESEND_ECF_TEMPLATE_ID",
        "RESEND_ECF_RECIPIENT",
        "RESEND_FROM",
    ):
        if source.get(key):
            api_values[key] = source[key]
    api_values["SUPABASE_PRODUCT_IMAGE_BUCKET"] = source.get(
        "SUPABASE_PRODUCT_IMAGE_BUCKET", "product-images"
    )

    commit = subprocess.run(
        ["git", "rev-parse", "--short=12", "HEAD"],
        cwd=REPOSITORY_ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    deploy_values = {
        "ALLPA_IMAGE_TAG": f"{commit}-{timestamp}",
        "NEXT_PUBLIC_API_URL": "https://allpa.corestack-systems.com/api",
        "NEXT_PUBLIC_APP_URL": "https://allpa.corestack-systems.com",
    }

    write_env(API_ENV, api_values)
    write_env(DEPLOY_ENV, deploy_values)
    print(f"api_keys={len(api_values)}")
    print(f"image_tag={deploy_values['ALLPA_IMAGE_TAG']}")
    print("ALLPA_PRODUCTION_ENVIRONMENT_PREPARED")


if __name__ == "__main__":
    main()
