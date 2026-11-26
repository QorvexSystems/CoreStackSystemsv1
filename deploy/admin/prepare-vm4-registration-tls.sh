#!/usr/bin/env bash
# Infrastructure TLS only. No tax signing certificate, DB or container changes.
set -euo pipefail
umask 077
[[ $EUID == 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || { echo 'Run with sudo on VM4.' >&2; exit 1; }
readonly key=/opt/corestack/secrets/rivnu-fe-registration-tls.key
readonly csr=/opt/corestack/fe/config/rivnu-fe-registration.csr.pem
[[ -d /opt/corestack/secrets && -d /opt/corestack/fe/config ]] || exit 1
[[ ! -e "$key" && ! -e "$csr" ]] || { echo 'Existing material found; refusing to replace it.' >&2; exit 1; }
readonly work=$(mktemp -d /opt/corestack/secrets/registration-tls.XXXXXX)
cleanup() { rm -f -- "$work/key.pem" "$work/request.pem"; rmdir -- "$work"; }
trap cleanup EXIT
openssl req -new -newkey rsa:3072 -nodes -sha256 \
  -subj '/CN=CoreStack Fiscal Registration RIVNU' \
  -addext 'subjectAltName=IP:10.0.0.1' \
  -keyout "$work/key.pem" -out "$work/request.pem" 2>/dev/null
openssl req -in "$work/request.pem" -verify -noout
install -o 1000 -g 1000 -m 0400 "$work/key.pem" "$key"
install -o root -g root -m 0444 "$work/request.pem" "$csr"
echo 'REGISTRATION_TLS_CSR_CREATED_NOT_ACTIVATED'
echo "Public CSR: $csr"
echo 'Private key retained in VM4; do not copy or display it.'
