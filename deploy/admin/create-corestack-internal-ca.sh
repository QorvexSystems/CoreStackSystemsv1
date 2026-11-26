#!/usr/bin/env bash
# Run personally with sudo on VM3. Bootstraps an encrypted CA for initial
# issuance only; custody must move offline before relying on it for production.
# Does NOT issue a server certificate, install trust, reload or restart anything.
set +x
set -euo pipefail
umask 077
ulimit -c 0
if [[ "$EUID" -ne 0 || "$(hostname)" != 'VM3-SQLDB' ]]; then
  echo 'Run with sudo on VM3-SQLDB.' >&2
  exit 1
fi
readonly pki_root='/var/lib/corestack-pki'
readonly ca_dir='/var/lib/corestack-pki/internal-root-2026'
readonly public_dir='/usr/local/share/corestack-pki'
readonly public_cert='/usr/local/share/corestack-pki/internal-root-2026.crt'
for command_name in openssl flock stat mktemp; do command -v "$command_name" >/dev/null; done

# All parent locations are root-managed; do not put CA keys under the shared
# group-writable /opt/corestack tree. Refuse existing unexpected permissions.
if [[ ! -e "$pki_root" && ! -L "$pki_root" ]]; then mkdir -m 0700 "$pki_root"; fi
if [[ -L "$pki_root" || ! -d "$pki_root" || "$(stat -c '%u:%g:%a' "$pki_root")" != '0:0:700' ]]; then
  echo 'Unexpected PKI directory ownership/permissions; refusing to alter it.' >&2; exit 1
fi
exec 9>"$pki_root/.bootstrap.lock"
flock -n 9 || { echo 'Another CA bootstrap is running.' >&2; exit 1; }
if [[ -e "$ca_dir" || -L "$ca_dir" || -e "$public_cert" || -L "$public_cert" ]]; then
  echo 'CA or public certificate already exists; no overwrite or rotation performed.' >&2; exit 1
fi
if [[ ! -e "$public_dir" && ! -L "$public_dir" ]]; then mkdir -m 0755 "$public_dir"; fi
if [[ -L "$public_dir" || ! -d "$public_dir" || "$(stat -c '%u:%g:%a' "$public_dir")" != '0:0:755' ]]; then
  echo 'Unexpected public certificate directory; refusing to alter it.' >&2; exit 1
fi
if [[ ! -t 0 || ! -t 1 ]]; then
  echo 'An interactive terminal is required. Do not put the passphrase in arguments, environment or chat.' >&2; exit 1
fi

ca_stage=''
cleanup() {
  local result=$?
  unset ca_passphrase ca_confirmation
  if [[ "$result" -ne 0 && -n "$ca_stage" ]]; then
    printf 'Bootstrap incomplete. Protected staging retained for administrator review: %s\n' "$ca_stage" >&2
  fi
}
trap cleanup EXIT
printf 'Choose a unique passphrase (at least 20 characters), saved in your password manager.\n'
IFS= read -r -s -p 'New CA passphrase: ' ca_passphrase; printf '\n'
IFS= read -r -s -p 'Repeat CA passphrase: ' ca_confirmation; printf '\n'
if [[ ${#ca_passphrase} -lt 20 || "$ca_passphrase" != "$ca_confirmation" ]]; then
  echo 'Passphrases differ or are too short. No key generated.' >&2; exit 1
fi
unset ca_confirmation
ca_stage="$(mktemp -d "$pki_root/.internal-root-2026-init.XXXXXX")"
mkdir -m 0700 "$ca_stage/private"

# Unencrypted key material exists only in the process pipe, never on disk.
# Passphrase is fed through a private descriptor, never argv or environment.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  | openssl pkcs8 -topk8 -v2 aes-256-cbc -iter 600000 \
      -passout fd:3 -out "$ca_stage/private/ca.key.pem" 3<<<"$ca_passphrase"
chmod 0400 "$ca_stage/private/ca.key.pem"
openssl req -new -x509 -sha256 -days 1825 \
  -set_serial "0x$(openssl rand -hex 16)" \
  -key "$ca_stage/private/ca.key.pem" -passin fd:3 \
  -subj '/O=CoreStack/CN=CoreStack Infrastructure Root CA 2026' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -addext 'subjectKeyIdentifier=hash' \
  -addext 'authorityKeyIdentifier=keyid:always' \
  -out "$ca_stage/ca.crt.pem" 3<<<"$ca_passphrase"
unset ca_passphrase
chmod 0444 "$ca_stage/ca.crt.pem"
openssl verify -CAfile "$ca_stage/ca.crt.pem" "$ca_stage/ca.crt.pem"
mv -T -- "$ca_stage" "$ca_dir"
ca_stage=''
install -m 0444 "$ca_dir/ca.crt.pem" "$public_cert"
printf '\nCA_CREATED — encrypted private key remains root-only; no services changed.\n'
printf 'Temporary custody directory: %s\nPublic certificate: %s\n' "$ca_dir" "$public_cert"
openssl x509 -in "$public_cert" -noout -subject -dates -fingerprint -sha256
printf 'NEXT: make and verify an encrypted OFF-VM backup; keep the passphrase separately.\n'
printf 'No server certificate or trust has been deployed. Do not send the private key or passphrase.\n'
