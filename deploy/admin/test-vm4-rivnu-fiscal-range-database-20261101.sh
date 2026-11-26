#!/usr/bin/env bash
# Read-only remote verification of the dedicated production range identity.
set -Eeuo pipefail
set +x

readonly secret='/opt/corestack/secrets/rivnu-range-registration/postgresql.password'
readonly ca='/opt/corestack/fe/config/internal-root-2026.crt'
readonly image='postgres:17-alpine'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -f "$secret" && ! -L "$secret" && "$(stat -c '%u:%g:%a' "$secret")" == '0:4101:440' && -s "$secret" ]] || fail 'RANGE_DATABASE_SECRET_INVALID'
[[ -f "$ca" && ! -L "$ca" && -s "$ca" ]] || fail 'POSTGRESQL_CA_INVALID'
docker image inspect "$image" >/dev/null 2>&1 || fail 'POSTGRESQL_17_CLIENT_IMAGE_MISSING'

docker run --rm --network host --read-only \
  --user 10003:4101 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 32 \
  --memory 96m \
  --cpus 0.25 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2m,mode=0700,uid=10003,gid=4101 \
  -v "$secret:/run/secrets/postgresql-password:ro" \
  -v "$ca:/run/secrets/postgresql-ca.crt:ro" \
  --entrypoint sh \
  "$image" \
  -c '
set -eu
raw=$(cat /run/secrets/postgresql-password)
escaped=$(printf %s "$raw" | sed "s/\\\\/\\\\\\\\/g; s/:/\\\\:/g")
unset raw
printf "10.0.0.4:5432:rivnu_fiscal_prod:rivnu_fe_prod_range:%s\n" "$escaped" > /tmp/pgpass
printf "10.0.0.4:5432:postgres:rivnu_fe_prod_range:%s\n" "$escaped" >> /tmp/pgpass
unset escaped
chmod 0600 /tmp/pgpass
export PGPASSFILE=/tmp/pgpass PGSSLROOTCERT=/run/secrets/postgresql-ca.crt PGCONNECT_TIMEOUT=5

sql=$(printf %s U0VMRUNUIGN1cnJlbnRfdXNlcnx8J3wnfHxjdXJyZW50X2RhdGFiYXNlKCl8fCd8J3x8cy5zc2x8fCd8J3x8bS50ZW5hbnRfaWR8fCd8J3x8bS5pc3N1ZXJfcm5jfHwnfCd8fG0uZW52aXJvbm1lbnR8fCd8J3x8aGFzX2Z1bmN0aW9uX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsJ2NvcmVzdGFja19maXNjYWwucmVnaXN0ZXJfYXV0aG9yaXplZF9yYW5nZSh0ZXh0LHRleHQsdGV4dCxzbWFsbGludCxiaWdpbnQsYmlnaW50LGJpZ2ludCx0ZXh0LGRhdGUsZGF0ZSknLCdFWEVDVVRFJyl8fCd8J3x8aGFzX3RhYmxlX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsJ2NvcmVzdGFja19maXNjYWwuc2VxdWVuY2VfcmFuZ2UnLCdTRUxFQ1QsSU5TRVJULFVQREFURSxERUxFVEUnKSBGUk9NIGZpc2NhbF9tZXRhLmlzc3Vlcl9zY29wZSBtIENST1NTIEpPSU4gcGdfc3RhdF9zc2wgcyBXSEVSRSBzLnBpZD1wZ19iYWNrZW5kX3BpZCgp | base64 -d)
actual=$(PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_range -d rivnu_fiscal_prod -Atv ON_ERROR_STOP=1 -c "$sql")
unset sql
if [ "$actual" != "rivnu_fe_prod_range|rivnu_fiscal_prod|true|cmt397emm0002nm0ogb50l2q6|40220429126|production|true|false" ]; then
  printf "RIVNU_RANGE_SAFE_STATE=%s\n" "$actual" >&2
  exit 21
fi

if PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_range -d rivnu_fiscal_prod -Atqc \
  "SELECT 1 FROM corestack_fiscal.sequence_range" >/dev/null 2>&1; then exit 22; fi
if PGSSLMODE=disable psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_range -d rivnu_fiscal_prod -Atqc \
  "SELECT 1" >/dev/null 2>&1; then exit 23; fi
if PGSSLMODE=verify-full psql -X -h 10.0.0.4 -p 5432 -U rivnu_fe_prod_range -d postgres -Atqc \
  "SELECT 1" >/dev/null 2>&1; then exit 24; fi

printf "%s\n" RIVNU_FISCAL_RANGE_DATABASE_TLS_AND_DENIAL_TESTS_PASSED
'

printf '%s\n' 'No range, sequence, invoice, service, credential or DGII endpoint was changed.'
