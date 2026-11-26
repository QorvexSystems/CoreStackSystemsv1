#!/usr/bin/env bash
set -Eeuo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] ||
  fail RUN_WITH_SUDO_ON_VM4

printf '\n=== CONTAINERS ===\n'
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}'

printf '\n=== FISCAL CONFIGURATION (SAFE FIELDS ONLY) ===\n'
python3 - <<'PY'
import json
from pathlib import Path

paths = sorted(Path('/opt/corestack/fe/config').glob('fiscal-*.json'))
allowed = {
    'host', 'port', 'database', 'sslMode', 'serverName', 'endpoint', 'baseUrl',
    'tenantId', 'issuerRnc', 'environment', 'paused', 'certificateSha256',
    'expectedCertificateSha256', 'allowedCertificateSha256', 'evidenceRoot',
}

def safe(value):
    if isinstance(value, dict):
        return {k: safe(v) for k, v in value.items() if k in allowed or k == 'scope'}
    if isinstance(value, list):
        return [safe(v) for v in value]
    return value

for path in paths:
    print(f'FILE={path}')
    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        print(f'INVALID_JSON={type(exc).__name__}')
        continue
    print(json.dumps(safe(data), sort_keys=True, separators=(',', ':')))
PY

printf '\n=== CONFIG AND TRUST METADATA ===\n'
find /opt/corestack/fe/config /opt/corestack/fe/config/trust/dgii \
  -maxdepth 2 -type f \
  \( -name 'fiscal-*.json' -o -name '*.crt' -o -name '*.pem' \) \
  -exec stat -c '%a | %U:%G | %s | %n' {} + 2>/dev/null | sort

printf '\n=== SIGNING CERTIFICATE (PUBLIC METADATA) ===\n'
readonly p12=/opt/corestack/secrets/rivnu-signer-runtime/certificate.p12
readonly p12_password=/opt/corestack/secrets/rivnu-signer-runtime/certificate.password
[[ -f "$p12" && ! -L "$p12" && -f "$p12_password" && ! -L "$p12_password" ]] ||
  fail SIGNING_IDENTITY_MISSING
work="$(mktemp -d)"
cleanup() { rm -f -- "$work/leaf.pem"; rmdir -- "$work" 2>/dev/null || true; }
trap cleanup EXIT
openssl pkcs12 -in "$p12" -passin "file:$p12_password" -clcerts -nokeys -out "$work/leaf.pem" 2>/dev/null
openssl x509 -in "$work/leaf.pem" -noout -subject -issuer -serial -dates -fingerprint -sha256

printf '\n=== CRL ===\n'
readonly crl=/opt/corestack/secrets/rivnu-signer-runtime/subordinate.crl.pem
[[ -f "$crl" && ! -L "$crl" ]] || fail SIGNING_CRL_MISSING
openssl crl -in "$crl" -noout -issuer -lastupdate -nextupdate -fingerprint -sha256

printf '\n=== RECEIVER ===\n'
readonly receiver=corestack-fiscal-receiver-fiscal-receiver-1
docker inspect "$receiver" --format 'IMAGE={{.Image}} STATUS={{.State.Status}} HEALTH={{if .State.Health}}{{.State.Health.Status}}{{end}}'
ss -lntp 'sport = :8444' || true
curl --fail --silent --show-error --connect-timeout 5 \
  --noproxy '*' \
  --cacert /opt/corestack/fe/config/fiscal-receiver-tls.crt \
  --resolve rivnu-fiscal-receiver.internal:8444:10.0.0.1 \
  https://rivnu-fiscal-receiver.internal:8444/health/live
printf '\n'

printf '\n=== RECENT FISCAL ERRORS (SANITIZED APPLICATION EVENTS) ===\n'
for container in $(docker ps --format '{{.Names}}' | grep '^corestack-fiscal-' || true); do
  printf -- '--- %s ---\n' "$container"
  docker logs --since 24h "$container" 2>&1 |
    grep -E 'PRODUCTION_DISABLED|REQUEST_REJECTED|SIGNATURE_REJECTED|CERTIFICATE|ERROR|FAILED' |
    tail -20 || true
done

printf '\nRIVNU_VM4_PRODUCTION_READINESS_AUDIT_COMPLETE_NO_CHANGES\n'
