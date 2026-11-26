#!/usr/bin/env bash
# Assign the dedicated SCRAM credential while the production role stays NOLOGIN.
set -Eeuo pipefail
set +x
umask 077

readonly database='rivnu_fiscal_prod'
readonly role='rivnu_fe_prod_range'
readonly tenant='cmt397emm0002nm0ogb50l2q6'
readonly rnc='40220429126'

fail() { printf '%s\n' "$1" >&2; exit 1; }
pg() {
  sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 \
    -d "$database" -v ON_ERROR_STOP=1 "$@"
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'RUN_WITH_SUDO_ON_VM3'
[[ -t 0 && -t 1 ]] || fail 'INTERACTIVE_TTY_REQUIRED'
[[ "$(pg -Atqc 'SHOW password_encryption')" == 'scram-sha-256' ]] || fail 'POSTGRESQL_SCRAM_REQUIRED'
[[ "$(pg -Atqc "SELECT count(*) FROM pg_roles WHERE rolname='$role' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolconnlimit=4")" == '1' ]] || fail 'RANGE_ROLE_NOT_LOCKED'
[[ "$(pg -Atqc "SELECT tenant_id||'|'||issuer_rnc||'|'||environment FROM fiscal_meta.issuer_scope WHERE singleton")" == "$tenant|$rnc|production" ]] || fail 'FISCAL_SCOPE_INVALID'
[[ "$(pg -Atqc "SELECT count(*) FROM fiscal_meta.range_registration_identity WHERE login_role='$role' AND tenant_id='$tenant' AND issuer_rnc='$rnc' AND environment='production'")" == '1' ]] || fail 'RANGE_IDENTITY_INVALID'

password_state=$(pg -Atqc "SELECT CASE WHEN rolpassword IS NULL THEN 'EMPTY' WHEN rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'SCRAM' ELSE 'INVALID' END FROM pg_authid WHERE rolname='$role'")
case "$password_state" in
  EMPTY)
    printf '%s\n' 'Pegue una contraseña aleatoria exclusiva. PostgreSQL la solicitará dos veces y no la mostrará.'
    pg -c "SET password_encryption='scram-sha-256'" -c "\\password $role"
    ;;
  SCRAM)
    printf '%s\n' 'RIVNU_FISCAL_RANGE_SCRAM_ALREADY_ASSIGNED_NOLOGIN'
    ;;
  *) fail 'RANGE_CREDENTIAL_STATE_INVALID' ;;
esac

[[ "$(pg -Atqc "SELECT count(*) FROM pg_authid WHERE rolname='$role' AND NOT rolcanlogin AND rolpassword LIKE 'SCRAM-SHA-256$%' AND (rolvaliduntil IS NULL OR rolvaliduntil>now())")" == '1' ]] || fail 'SCRAM_ASSIGNMENT_VERIFICATION_FAILED'

printf '%s\n' 'RIVNU_FISCAL_RANGE_SCRAM_ASSIGNED_NOLOGIN'
printf '%s\n' 'The role remains disabled; no secret value, range, invoice, service or DGII request was emitted.'
