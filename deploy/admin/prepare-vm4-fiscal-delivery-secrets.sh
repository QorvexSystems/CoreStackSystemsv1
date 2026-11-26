#!/usr/bin/env bash
# Store existing VM3 credentials without displaying them. Does not start services.
set -euo pipefail
set +x
umask 077

readonly directory='/opt/corestack/secrets'
readonly signer_secret="$directory/rivnu-fe-pre-signer-postgresql.password"
readonly delivery_secret="$directory/rivnu-fe-pre-delivery-postgresql.password"
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -d "$directory" && ! -L "$directory" ]] || fail 'SECRETS_DIRECTORY_INVALID'
[[ ! -e "$signer_secret" && ! -L "$signer_secret" && ! -e "$delivery_secret" && ! -L "$delivery_secret" ]] || fail 'DELIVERY_SECRET_ALREADY_EXISTS_REVIEW_REQUIRED'

read_secret() {
  local label=$1 first second
  read -r -s -p "Contraseña existente de $label en VM3: " first </dev/tty
  printf '\n' >/dev/tty
  read -r -s -p 'Repita la contraseña: ' second </dev/tty
  printf '\n' >/dev/tty
  [[ -n "$first" && ${#first} -le 4096 && "$first" == "$second" && "$first" != *$'\n'* && "$first" != *$'\r'* ]] || fail 'SECRET_CONFIRMATION_FAILED'
  REPLY=$first
}

work=$(mktemp -d "$directory/.delivery-secrets.XXXXXX")
cleanup() { rm -f -- "$work/signer" "$work/delivery"; rmdir -- "$work" 2>/dev/null || true; }
trap cleanup EXIT
read_secret 'rivnu_fe_pre_signer'
printf %s "$REPLY" >"$work/signer"
unset REPLY
read_secret 'rivnu_fe_pre_delivery'
printf %s "$REPLY" >"$work/delivery"
unset REPLY
install -o root -g root -m 0400 "$work/signer" "$signer_secret"
install -o root -g root -m 0400 "$work/delivery" "$delivery_secret"
echo 'FISCAL_DELIVERY_SECRETS_STORED_ROOT_ONLY_NOT_ACTIVATED'
echo 'No service, database, queue state or DGII endpoint changed.'
