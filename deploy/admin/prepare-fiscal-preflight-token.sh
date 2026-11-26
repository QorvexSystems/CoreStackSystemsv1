#!/usr/bin/env bash
# Run personally by the VM4 administrator. Creates ONE credential; never prints it.
# No Docker, network, firewall, database or directory-permission changes.
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  echo 'Run with sudo on VM4.' >&2
  exit 1
fi
if [[ "$(hostname)" != 'CoreStackSystems-VM4-Billing' ]]; then
  echo 'Refusing to run outside the confirmed VM4 hostname.' >&2
  exit 1
fi
readonly secret_dir='/opt/corestack/secrets'
readonly secret_file='/opt/corestack/secrets/fiscal-preflight.token'
if [[ ! -d "$secret_dir" || -L "$secret_dir" || "$(stat -c '%u:%a' "$secret_dir")" != '0:700' ]]; then
  echo 'Expected a real root-owned secrets directory with mode 0700; no permissions changed.' >&2
  exit 1
fi
if [[ -e "$secret_file" || -L "$secret_file" ]]; then
  echo 'Credential already exists; refusing to overwrite or rotate it.' >&2
  exit 1
fi
command -v openssl >/dev/null
umask 077
token_temp="$(mktemp /opt/corestack/secrets/.fiscal-preflight.token.XXXXXX)"
trap 'rm -f -- "$token_temp"' EXIT
# 256 bits of entropy, hex encoding accepted by the service. No output to terminal.
openssl rand -hex -out "$token_temp" 32
test "$(wc -c < "$token_temp")" -eq 65
LC_ALL=C grep -Eq '^[0-9a-f]{64}$' "$token_temp"
# The image uses UID/GID 1000. Parent remains root:root 0700; Docker mounts
# only this file read-only, not the entire secrets directory.
chown 1000:1000 "$token_temp"
chmod 0400 "$token_temp"
# Atomic no-clobber publication: a concurrent run cannot replace the credential.
ln -- "$token_temp" "$secret_file"
echo 'Credential created for the fiscal preflight container; value not displayed.'
