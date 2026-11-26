#!/usr/bin/env bash
# Assign two independent SCRAM credentials, then enable LOGIN while queue is paused.
set -euo pipefail
set +x
umask 077

readonly enable_sql='/home/luismel/enable-rivnu-fiscal-delivery-identities.sql'
readonly expected_sql_hash='86d38fd2c36aef329c0215a1ed82c9eb63069ecabafe37eef6ed43f67f6195bf'
fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() { sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 "$@"; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -f "$enable_sql" && ! -L "$enable_sql" ]] || fail 'ENABLE_SQL_INVALID'
[[ "$(sha256sum "$enable_sql" | cut -d' ' -f1)" == "$expected_sql_hash" ]] || fail 'ENABLE_SQL_HASH_MISMATCH'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname IN ('rivnu_fe_pre_signer','rivnu_fe_pre_delivery') AND NOT rolcanlogin")" == '2' ]] || fail 'DELIVERY_ROLES_NOT_LOCKED'
[[ "$(pg -Atqc "SELECT paused FROM corestack_fiscal.delivery_control WHERE tenant_id='cmt397emm0002nm0ogb50l2q6' AND issuer_rnc='40220429126' AND environment='precertification'")" == 't' ]] || fail 'DELIVERY_QUEUE_NOT_PAUSED'
passwords=$(pg -Atqc "SELECT count(*) FROM pg_authid WHERE rolname IN ('rivnu_fe_pre_signer','rivnu_fe_pre_delivery') AND rolpassword LIKE 'SCRAM-SHA-256$%'")
if [[ "$passwords" == '0' ]]; then
  printf '%s\n' 'Asigne contraseñas DIFERENTES. No se mostrarán ni se escribirán en logs.'
  pg -c "SET password_encryption='scram-sha-256'" -c '\password rivnu_fe_pre_signer'
  pg -c "SET password_encryption='scram-sha-256'" -c '\password rivnu_fe_pre_delivery'
elif [[ "$passwords" == '2' ]]; then
  echo 'RESUMING_WITH_EXISTING_SCRAM_CREDENTIALS'
else
  fail 'PARTIAL_DELIVERY_CREDENTIAL_STATE_REVIEW_REQUIRED'
fi
# Root opens the reviewed file; the postgres OS account cannot traverse this home directory.
pg <"$enable_sql"
echo 'Credentials assigned; copy the same two values into VM4 using the prepared secret script.'
