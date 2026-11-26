#!/usr/bin/env bash
set -euo pipefail
[[ $(hostname) == CoreStackSystems-VM4-Billing ]] || exit 1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ "$root" == /opt/corestack/fe/compose/preview-remote.* ]] || exit 1
[[ ! -e "$root/credentials" ]] || { echo CREDENTIALS_EXIST_NO_OVERWRITE; exit 1; }
umask 077
mkdir -m 0700 "$root/credentials"
for file in token db-admin db-runtime; do openssl rand -hex -out "$root/credentials/$file" 32; done
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=CoreStack Synthetic Preview ONLY' \
 -addext 'subjectAltName=IP:10.0.0.1,IP:127.0.0.1' -addext 'extendedKeyUsage=serverAuth' \
 -keyout "$root/credentials/server.key" -out "$root/credentials/server.crt" >/dev/null 2>&1
chmod 0400 "$root/credentials/token" "$root/credentials/server.key"
# Separate DB containers receive only the individual required files. Parent is 0700.
chmod 0444 "$root/credentials/db-admin" "$root/credentials/db-runtime" "$root/credentials/server.crt"
echo PREVIEW_CREDENTIALS_CREATED_VALUES_NOT_DISPLAYED
