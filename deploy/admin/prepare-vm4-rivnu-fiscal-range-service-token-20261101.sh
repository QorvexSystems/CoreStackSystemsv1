#!/usr/bin/env bash
# Store the dedicated API-to-fiscal-core bearer token on VM4. No activation.
set -Eeuo pipefail
set +x
umask 077

readonly directory='/opt/corestack/secrets/rivnu-range-registration'
readonly target="$directory/service.token"
readonly service_gid='4101'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -t 0 && -t 1 ]] || fail 'INTERACTIVE_TTY_REQUIRED'
[[ -d "$directory" && ! -L "$directory" && "$(stat -c '%u:%g:%a' "$directory")" == "0:$service_gid:750" ]] || fail 'RANGE_SECRET_DIRECTORY_INVALID'
[[ ! -e "$target" && ! -L "$target" ]] || fail 'RANGE_SERVICE_TOKEN_EXISTS_REVIEW_REQUIRED'

first=''
second=''
read -r -s -p 'Token base64url exclusivo del servicio de rangos: ' first </dev/tty
printf '\n' >/dev/tty
read -r -s -p 'Repita exactamente el mismo token: ' second </dev/tty
printf '\n' >/dev/tty
[[ "$first" == "$second" ]] || fail 'TOKEN_CONFIRMATION_FAILED'
[[ "$first" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'TOKEN_FORMAT_INVALID'

work=$(mktemp -d /opt/corestack/secrets/.rivnu-range-token.XXXXXX)
cleanup() {
  unset first second
  rm -f -- "$work/service.token"
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
printf %s "$first" >"$work/service.token"
unset first second
install -o root -g "$service_gid" -m 0440 "$work/service.token" "$target"
[[ "$(stat -c '%u:%g:%a' "$target")" == "0:$service_gid:440" && -s "$target" && ! -L "$target" ]] || fail 'RANGE_SERVICE_TOKEN_PERMISSIONS_INVALID'

printf '%s\n' 'RIVNU_FISCAL_RANGE_SERVICE_TOKEN_STORED_NOT_ACTIVATED'
printf '%s\n' 'No service, route, database, range, invoice or DGII endpoint was activated.'
