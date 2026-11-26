#!/usr/bin/env python3
"""Create private VM2/VM3 deployment credentials without printing their values."""

import os
import secrets
from pathlib import Path
from urllib.parse import quote

ROOT = Path('/opt/corestack/apps/hotelancla')
SOURCE = ROOT / 'repo/Hotel/.env'
DEST = ROOT / 'secrets'
DATABASE = 'hotelancla_production'
HOST = '10.0.0.4'
TAG = 'zip-839dfbefc791'


def read_env(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key.strip()] = value
    return result


def database_url(role: str, password: str) -> str:
    return (
        f'postgresql://{role}:{quote(password, safe="")}@{HOST}:5432/'
        f'{DATABASE}?schema=public&sslmode=require'
    )


def lines(values: dict[str, str]) -> str:
    for key, value in values.items():
        if not key.replace('_', '').isalnum() or '\n' in value or '\r' in value:
            raise ValueError(f'Variable inválida: {key}')
    return ''.join(f'{key}={value}\n' for key, value in values.items())


def write_private(path: Path, contents: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(contents)


def main() -> None:
    source = read_env(SOURCE)
    if not source.get('DIRECT_URL') or not source.get('SUPABASE_URL'):
        raise RuntimeError('El .env de origen no parece ser el de Hotel Ancla')

    filenames = ['vm3-provision.env', 'migrator.env', 'api.env', 'website.env', 'deploy.env']
    DEST.mkdir(mode=0o700, exist_ok=True)
    os.chmod(DEST, 0o700)
    if any((DEST / name).exists() for name in filenames):
        raise RuntimeError('Ya existen secretos de despliegue; no se sobrescribieron')

    migrator_password = secrets.token_urlsafe(48)
    runtime_password = secrets.token_urlsafe(48)
    migrator_url = database_url('hotelancla_migrator', migrator_password)
    runtime_url = database_url('hotelancla_runtime', runtime_password)
    channel_secret = source.get('CHANNEL_API_SECRET', '')
    if len(channel_secret) < 32:
        channel_secret = secrets.token_urlsafe(48)
    channel_key = source.get('CHANNEL_API_KEY_ID') or 'hotelancla-website'

    provision = {
        'HOTELANCLA_MIGRATOR_PASSWORD': migrator_password,
        'HOTELANCLA_RUNTIME_PASSWORD': runtime_password,
    }
    migrator = {
        'DATABASE_URL': migrator_url,
        'DIRECT_URL': migrator_url,
        'PG_DUMP_URL': migrator_url,
    }
    api = {
        'NODE_ENV': 'production',
        'DATABASE_URL': runtime_url,
        'DIRECT_URL': runtime_url,
        'JWT_SECRET': secrets.token_urlsafe(48),
        'JWT_EXPIRES_IN': source.get('JWT_EXPIRES_IN') or '8h',
        'API_PORT': '4000',
        'CORS_ORIGIN': 'https://hotelancla.corestack-systems.com,https://hotelancla-reservas.corestack-systems.com',
        'TRUST_PROXY': '1',
        'CHANNEL_API_KEY_ID': channel_key,
        'CHANNEL_API_SECRET': channel_secret,
        'CHANNEL_TENANT_SLUG': 'hotel-ancla',
        'HOTEL_WEB_TAX_RATE': source.get('HOTEL_WEB_TAX_RATE') or '0.18',
        'ENABLE_EMAIL_DELIVERY': 'false',
    }
    for key in (
        'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
        'SUPABASE_JWKS_URL', 'SUPABASE_PRODUCT_IMAGE_BUCKET', 'SUPABASE_WEB_CATALOG_BUCKET',
        'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
    ):
        if source.get(key):
            api[key] = source[key]
    if api.get('SUPABASE_URL') and (api.get('SUPABASE_SERVICE_ROLE_KEY') or api.get('SUPABASE_SECRET_KEY')):
        api['PRODUCT_IMAGE_STORAGE'] = 'supabase'

    website = {
        'NODE_ENV': 'production',
        'ERP_API_URL': 'http://api:4000',
        'CHANNEL_API_KEY_ID': channel_key,
        'CHANNEL_API_SECRET': channel_secret,
        'CHANNEL_TENANT_SLUG': 'hotel-ancla',
    }
    deploy = {
        'IMAGE_TAG': TAG,
        'NEXT_PUBLIC_API_URL': 'https://hotelancla-api.corestack-systems.com',
        'NEXT_PUBLIC_APP_URL': 'https://hotelancla.corestack-systems.com',
    }
    for name, values in (
        ('vm3-provision.env', provision),
        ('migrator.env', migrator),
        ('api.env', api),
        ('website.env', website),
        ('deploy.env', deploy),
    ):
        write_private(DEST / name, lines(values))
        print(DEST / name)


if __name__ == '__main__':
    main()
