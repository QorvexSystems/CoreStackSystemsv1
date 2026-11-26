#!/usr/bin/env bash
# Dedicated ERP registration credential. Never prints or replaces a secret.
set -euo pipefail
[[ $EUID == 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || { echo 'Run with sudo on VM4.' >&2; exit 1; }
readonly directory=/opt/corestack/secrets
readonly target=/opt/corestack/secrets/fiscal-registration.token
[[ -d "$directory" && ! -L "$directory" && "$(stat -c '%u:%a' "$directory")" == 0:700 ]] || {
  echo 'Expected root-owned secrets directory mode 0700; no permissions changed.' >&2; exit 1;
}
[[ ! -e "$target" && ! -L "$target" ]] || { echo 'Credential already exists; refusing to overwrite.' >&2; exit 1; }
umask 077
readonly temporary=$(mktemp /opt/corestack/secrets/.fiscal-registration.token.XXXXXX)
trap 'rm -f -- "$temporary"' EXIT
openssl rand -hex -out "$temporary" 32
[[ $(wc -c < "$temporary") == 65 ]]
LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$temporary"
chown 1000:1000 "$temporary"
chmod 0400 "$temporary"
ln -- "$temporary" "$target"
echo 'FISCAL_REGISTRATION_TOKEN_CREATED_NOT_DISPLAYED'
echo 'Dedicated credential only; no preflight rotation, ports, database or container changes.'
