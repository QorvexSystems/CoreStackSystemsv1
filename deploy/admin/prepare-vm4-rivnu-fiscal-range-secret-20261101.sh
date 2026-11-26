#!/usr/bin/env bash
# Store the existing VM3 range credential without displaying or replacing it.
set -Eeuo pipefail
set +x
umask 077

readonly secret_root='/opt/corestack/secrets'
readonly destination="$secret_root/rivnu-range-registration"
readonly target="$destination/postgresql.password"
readonly service_gid='4101'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -t 0 && -t 1 ]] || fail 'INTERACTIVE_TTY_REQUIRED'
[[ -d "$secret_root" && ! -L "$secret_root" ]] || fail 'SECRETS_ROOT_INVALID'
[[ "$(stat -c '%u:%g:%a' "$secret_root")" == '0:0:700' ]] || fail 'SECRETS_ROOT_PERMISSIONS_INVALID'
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'RANGE_SECRET_DESTINATION_EXISTS_REVIEW_REQUIRED'

first=''
second=''
read -r -s -p 'Contraseña SCRAM asignada a rivnu_fe_prod_range en VM3: ' first </dev/tty
printf '\n' >/dev/tty
read -r -s -p 'Repita exactamente la misma contraseña: ' second </dev/tty
printf '\n' >/dev/tty
[[ "$first" == "$second" ]] || fail 'SECRET_CONFIRMATION_FAILED'
[[ ${#first} -ge 32 && ${#first} -le 256 ]] || fail 'SECRET_LENGTH_INVALID'
[[ "$first" != *$'\n'* && "$first" != *$'\r'* ]] || fail 'SECRET_CONTENT_INVALID'

work=$(mktemp -d "$secret_root/.rivnu-range-registration.XXXXXX")
cleanup() {
  unset first second
  rm -f -- "$work/postgresql.password"
  rm -f -- "$work/publish/postgresql.password"
  rmdir -- "$work/publish" 2>/dev/null || true
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
printf %s "$first" >"$work/postgresql.password"
unset first second

install -d -o root -g "$service_gid" -m 0750 "$work/publish"
install -o root -g "$service_gid" -m 0440 "$work/postgresql.password" "$work/publish/postgresql.password"
[[ "$(stat -c '%u:%g:%a' "$work/publish")" == "0:$service_gid:750" ]] || fail 'RANGE_SECRET_DIRECTORY_PERMISSIONS_INVALID'
[[ "$(stat -c '%u:%g:%a' "$work/publish/postgresql.password")" == "0:$service_gid:440" && -s "$work/publish/postgresql.password" && ! -L "$work/publish/postgresql.password" ]] || fail 'RANGE_SECRET_PERMISSIONS_INVALID'
mv -T "$work/publish" "$destination"
[[ "$(stat -c '%u:%g:%a' "$destination")" == "0:$service_gid:750" ]] || fail 'PUBLISHED_RANGE_SECRET_DIRECTORY_INVALID'
[[ "$(stat -c '%u:%g:%a' "$target")" == "0:$service_gid:440" && -s "$target" && ! -L "$target" ]] || fail 'PUBLISHED_RANGE_SECRET_INVALID'

printf '%s\n' 'RIVNU_FISCAL_RANGE_DATABASE_SECRET_STORED_NOT_ACTIVATED'
printf '%s\n' 'No service, database login, range, invoice or DGII endpoint was activated.'
