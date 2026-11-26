#!/usr/bin/env bash
# Run by the CA custodian on VM3. Signs public CSR only; never receives VM4 key.
set -euo pipefail
umask 077
[[ $EUID == 0 && "$(hostname)" == VM3-SQLDB ]] || { echo 'Run with sudo on VM3.' >&2; exit 1; }
[[ $# == 1 && -f "$1" && ! -L "$1" ]] || { echo 'Supply the VM4 public CSR file.' >&2; exit 1; }
[[ $(stat -c %s -- "$1") -le 16384 ]] || exit 1
readonly ca=/var/lib/corestack-pki/internal-root-2026
readonly output=/usr/local/share/corestack-pki/rivnu-fe-registration-2026.crt
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
[[ ! -e "$output" ]] || { echo 'Existing certificate found; refusing to overwrite.' >&2; exit 1; }
[[ "$(openssl x509 -in "$ca/ca.crt.pem" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || exit 1
openssl x509 -in "$ca/ca.crt.pem" -noout -checkend 31622400
readonly work=$(mktemp -d /var/lib/corestack-pki/registration-issue.XXXXXX)
cleanup() { rm -f -- "$work/request.pem" "$work/extensions.cnf" "$work/server.crt"; rmdir -- "$work"; }
trap cleanup EXIT
install -m 0400 "$1" "$work/request.pem"
openssl req -in "$work/request.pem" -noout -verify
[[ "$(openssl req -in "$work/request.pem" -noout -subject -nameopt RFC2253)" == 'subject=CN=CoreStack Fiscal Registration RIVNU' ]] || exit 1
printf '%s\n' '[server]' 'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' \
  'subjectAltName=IP:10.0.0.1' 'subjectKeyIdentifier=hash' 'authorityKeyIdentifier=keyid,issuer' > "$work/extensions.cnf"
echo 'Enter the internal CA passphrase at the OpenSSL prompt; never send it through chat.'
openssl x509 -req -in "$work/request.pem" -CA "$ca/ca.crt.pem" -CAkey "$ca/private/ca.key.pem" \
  -set_serial "0x$(openssl rand -hex 16)" -days 365 -sha256 \
  -extfile "$work/extensions.cnf" -extensions server -out "$work/server.crt"
openssl verify -CAfile "$ca/ca.crt.pem" -purpose sslserver -verify_ip 10.0.0.1 "$work/server.crt"
install -o root -g root -m 0444 "$work/server.crt" "$output"
openssl x509 -in "$output" -noout -subject -issuer -dates -fingerprint -sha256
echo "REGISTRATION_TLS_CERTIFICATE_ISSUED_NOT_ACTIVATED: $output"
echo 'No PostgreSQL, firewall, ERP, containers or fiscal signing settings changed.'
