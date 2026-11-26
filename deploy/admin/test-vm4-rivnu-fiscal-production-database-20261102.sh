#!/usr/bin/env bash
# Read-only TLS, identity and minimum-privilege verification before activation.
set -Eeuo pipefail
set +x
umask 077

readonly secret='/opt/corestack/secrets/rivnu-fiscal-production/postgresql.password'
readonly ca='/opt/corestack/fe/config/internal-root-2026.crt'
readonly image='postgres:17-alpine'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -f "$secret" && ! -L "$secret" && "$(stat -c '%u:%g:%a' "$secret")" == '0:4101:440' && -s "$secret" ]] || fail 'FISCAL_RUNTIME_DATABASE_SECRET_INVALID'
[[ -f "$ca" && ! -L "$ca" && -s "$ca" ]] || fail 'POSTGRESQL_CA_INVALID'
docker image inspect "$image" >/dev/null 2>&1 || fail 'POSTGRESQL_17_CLIENT_IMAGE_MISSING'

docker run --rm --network host --read-only \
  --user 10004:4101 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 96m \
  --cpus 0.25 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2m,mode=0700,uid=10004,gid=4101 \
  -v "$secret:/run/secrets/postgresql-password:ro" \
  -v "$ca:/run/secrets/postgresql-ca.crt:ro" \
  --entrypoint sh \
  "$image" \
  -c '
set -eu
raw=$(cat /run/secrets/postgresql-password)
escaped=$(printf %s "$raw" | sed "s/\\\\/\\\\\\\\/g; s/:/\\\\:/g")
unset raw
printf "10.0.0.4:5432:rivnu_fiscal_prod:rivnu_fe_prod_runtime:%s\n" "$escaped" > /tmp/pgpass
printf "10.0.0.4:5432:postgres:rivnu_fe_prod_runtime:%s\n" "$escaped" >> /tmp/pgpass
unset escaped
chmod 0600 /tmp/pgpass
export PGPASSFILE=/tmp/pgpass PGSSLROOTCERT=/run/secrets/postgresql-ca.crt PGCONNECT_TIMEOUT=5

sql=$(printf %s U0VMRUNUIGN1cnJlbnRfdXNlcnx8J3wnfHxjdXJyZW50X2RhdGFiYXNlKCl8fCd8J3x8cy5zc2x8fCd8J3x8bS50ZW5hbnRfaWR8fCd8J3x8bS5pc3N1ZXJfcm5jfHwnfCd8fG0uZW52aXJvbm1lbnR8fCd8J3x8aGFzX2Z1bmN0aW9uX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsJ2NvcmVzdGFja19maXNjYWwuY2xhaW1fZGVsaXZlcnkoKScsJ0VYRUNVVEUnKXx8J3wnfHxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlciwnY29yZXN0YWNrX2Zpc2NhbC5zZXF1ZW5jZV9yYW5nZScsJ1NFTEVDVCxJTlNFUlQsVVBEQVRFLERFTEVURScpIEZST00gZmlzY2FsX21ldGEuaXNzdWVyX3Njb3BlIG0gQ1JPU1MgSk9JTiBwZ19zdGF0X3NzbCBzIFdIRVJFIHMucGlkPXBnX2JhY2tlbmRfcGlkKCk= | base64 -d)
actual=$(PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_runtime \
  -d rivnu_fiscal_prod -Atv ON_ERROR_STOP=1 -c "$sql")
unset sql
if [ "$actual" != "rivnu_fe_prod_runtime|rivnu_fiscal_prod|true|cmqn0r66a0002lit0vxbzq5l4|40220429126|production|true|false" ]; then
  printf "RIVNU_FISCAL_RUNTIME_SAFE_STATE=%s\n" "$actual" >&2
  exit 21
fi

if PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_runtime \
  -d rivnu_fiscal_prod -Atqc "SELECT 1 FROM corestack_fiscal.sequence_range" >/dev/null 2>&1; then exit 22; fi
if PGSSLMODE=disable psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_runtime \
  -d rivnu_fiscal_prod -Atqc "SELECT 1" >/dev/null 2>&1; then exit 23; fi
if PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_runtime \
  -d postgres -Atqc "SELECT 1" >/dev/null 2>&1; then exit 24; fi

printf "%s\n" RIVNU_FISCAL_PRODUCTION_DATABASE_TLS_AND_DENIAL_TESTS_PASSED
'

printf '%s\n' 'No range, sequence, invoice, service, credential or DGII endpoint was changed.'
