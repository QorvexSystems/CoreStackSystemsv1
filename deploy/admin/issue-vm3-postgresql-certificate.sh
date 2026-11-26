#!/usr/bin/env bash
# Operator-run, initial leaf issuance only. Never changes PostgreSQL or HBA.
set +x
set -euo pipefail
umask 077
ulimit -c 0
readonly pki_root='/var/lib/corestack-pki'
readonly ca_dir="$pki_root/internal-root-2026"
readonly public_dir='/usr/local/share/corestack-pki'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly destination="$pki_root/issued/vm3-postgresql-2026"
readonly public_leaf="$public_dir/vm3-postgresql-2026.crt"
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$EUID" -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || fail 'Run personally with sudo on VM3-SQLDB.'
[[ -t 0 && -t 1 ]] || fail 'Interactive terminal required; never send the CA passphrase through chat or arguments.'
for command_name in openssl flock stat mktemp cmp install; do command -v "$command_name" >/dev/null; done
for directory in "$pki_root" "$ca_dir" "$ca_dir/private"; do
  [[ ! -L "$directory" && -d "$directory" && "$(stat -c '%u:%g:%a' "$directory")" == '0:0:700' ]] || fail "Unsafe directory: $directory"
done
[[ ! -L "$public_dir" && -d "$public_dir" && "$(stat -c '%u:%g:%a' "$public_dir")" == '0:0:755' ]] || fail 'Unsafe public certificate directory.'
for certificate in "$ca_dir/ca.crt.pem" "$public_dir/internal-root-2026.crt"; do
  [[ ! -L "$certificate" && -f "$certificate" && "$(stat -c '%u:%g:%a' "$certificate")" == '0:0:444' ]] || fail 'Unsafe CA certificate.'
  fingerprint=$(openssl x509 -in "$certificate" -noout -fingerprint -sha256)
  [[ "${fingerprint#*=}" == "$expected_ca" ]] || fail 'CA fingerprint mismatch; no issuance.'
done
readonly ca_key="$ca_dir/private/ca.key.pem"
[[ ! -L "$ca_key" && -f "$ca_key" && "$(stat -c '%u:%g:%a' "$ca_key")" == '0:0:400' ]] || fail 'Unsafe CA key permissions.'
openssl verify -check_ss_sig -CAfile "$ca_dir/ca.crt.pem" "$ca_dir/ca.crt.pem"
# Leaf validity must fit within the remaining CA validity (365 days + margin).
openssl x509 -in "$ca_dir/ca.crt.pem" -checkend 31622400 -noout || fail 'Renewal of CA required first.'
[[ ! -L "$pki_root/.leaf-issuance.lock" ]] || fail 'Unsafe lock.'
exec 9>"$pki_root/.leaf-issuance.lock"
flock -n 9 || fail 'Another issuance is running.'
[[ ! -e "$destination" && ! -L "$destination" && ! -e "$public_leaf" && ! -L "$public_leaf" ]] || fail 'Certificate already exists; no overwrite or rotation performed.'
if [[ ! -e "$pki_root/issued" && ! -L "$pki_root/issued" ]]; then mkdir -m 0700 "$pki_root/issued"; fi
[[ ! -L "$pki_root/issued" && "$(stat -c '%u:%g:%a' "$pki_root/issued")" == '0:0:700' ]] || fail 'Unsafe issuance directory.'

stage=''
cleanup() {
  local result=$?
  unset ca_passphrase
  if [[ "$result" -ne 0 && -n "$stage" ]]; then
    printf 'Incomplete issuance; protected staging retained: %s\n' "$stage" >&2
  fi
}
trap cleanup EXIT
IFS= read -r -s -p 'CA passphrase: ' ca_passphrase; printf '\n'
# Validate passphrase without printing/decrypting the CA key to disk.
openssl pkey -in "$ca_key" -passin fd:3 -pubout 3<<<"$ca_passphrase" \
  | openssl pkey -pubin -noout
stage=$(mktemp -d "$pki_root/issued/.vm3-postgresql-2026.XXXXXX")
# Fixed approved identity; do not copy arbitrary CSR extensions.
printf '%s\n' \
  '[server]' \
  'basicConstraints=critical,CA:FALSE' \
  'keyUsage=critical,digitalSignature,keyEncipherment' \
  'extendedKeyUsage=serverAuth' \
  'subjectAltName=DNS:VM3-SQLDB,IP:10.0.0.4' \
  'subjectKeyIdentifier=hash' \
  'authorityKeyIdentifier=keyid,issuer' > "$stage/extensions.cnf"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$stage/server.key.pem"
chmod 0400 "$stage/server.key.pem"
openssl req -new -sha256 -key "$stage/server.key.pem" -subj '/CN=VM3-SQLDB' -out "$stage/server.csr.pem"
openssl req -in "$stage/server.csr.pem" -verify -noout
openssl x509 -req -in "$stage/server.csr.pem" -CA "$ca_dir/ca.crt.pem" \
  -CAkey "$ca_key" -passin fd:3 -set_serial "0x$(openssl rand -hex 16)" \
  -days 365 -sha256 -extfile "$stage/extensions.cnf" -extensions server \
  -out "$stage/server.crt.pem" 3<<<"$ca_passphrase"
unset ca_passphrase
openssl verify -CAfile "$ca_dir/ca.crt.pem" -purpose sslserver -verify_ip 10.0.0.4 "$stage/server.crt.pem"
openssl verify -CAfile "$ca_dir/ca.crt.pem" -purpose sslserver -verify_hostname VM3-SQLDB "$stage/server.crt.pem"
openssl pkey -in "$stage/server.key.pem" -pubout -out "$stage/key-public.pem"
openssl x509 -in "$stage/server.crt.pem" -pubkey -noout > "$stage/cert-public.pem"
cmp "$stage/key-public.pem" "$stage/cert-public.pem"
chmod 0444 "$stage/server.crt.pem"
{
  printf 'purpose=PostgreSQL TLS server\nidentity=VM3-SQLDB,10.0.0.4\nca_sha256=%s\n' "$expected_ca"
  printf 'issued_at_utc=%s\nrenewal_policy=review 60 days before expiry\n' "$(date -u +%FT%TZ)"
  openssl x509 -in "$stage/server.crt.pem" -noout -serial -dates -fingerprint -sha256
} > "$stage/issuance.txt"
mv -T -- "$stage" "$destination"
stage=''
install -m 0444 "$destination/server.crt.pem" "$public_leaf"
printf '\nCERTIFICATE_ISSUED_NOT_ACTIVATED\nProtected bundle: %s\nPublic certificate: %s\n' "$destination" "$public_leaf"
openssl x509 -in "$public_leaf" -noout -subject -issuer -dates -serial -fingerprint -sha256
printf 'No PostgreSQL configuration, HBA, reload, restart or client trust changed.\n'
