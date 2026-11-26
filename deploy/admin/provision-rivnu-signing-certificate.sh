#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly source_p12='/home/luismel/rivnu-certificate-upload.d3IH5U/rivnu.p12'
readonly secret_root='/opt/corestack/secrets'
readonly destination_dir='/opt/corestack/secrets/rivnu-signing'
readonly public_dir='/opt/corestack/fe/config/trust/digifirma'
readonly expected_rnc='40220429126'
readonly expected_leaf_fingerprint='a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d'
readonly expected_root_sha1='d6ea339754cf4b6f41526a8e2a65a273575fe8fa'
readonly expected_subordinate_sha1='8d42a1098951a508d5ea1daa2a16958d348989cc'

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'RUN_WITH_SUDO'
[[ -d "$secret_root" && ! -L "$secret_root" ]] || fail 'SECRET_ROOT_INVALID'
[[ "$(stat -c '%U:%G:%a' "$secret_root")" == 'root:root:700' ]] || fail 'SECRET_ROOT_PERMISSIONS_INVALID'
[[ -f "$source_p12" && ! -L "$source_p12" ]] || fail 'P12_NOT_FOUND'
[[ "$(stat -c '%U:%G:%a' "$source_p12")" == 'luismel:luismel:600' ]] || fail 'P12_SOURCE_PERMISSIONS_INVALID'
[[ ! -e "$destination_dir" && ! -L "$destination_dir" ]] || fail 'DESTINATION_ALREADY_EXISTS_NO_OVERWRITE'

work=$(mktemp -d "$secret_root/.rivnu-signing-provision.XXXXXX")
cleanup() {
  code=$?
  unset p12_password p12_password_repeat
  rm -rf -- "$work"
  if (( code != 0 )); then echo 'PROVISIONING_ABORTED_NO_ACTIVATION' >&2; fi
  exit "$code"
}
trap cleanup EXIT

read -r -s -p 'Contraseña del certificado (no se mostrará): ' p12_password
printf '\n'
read -r -s -p 'Repita la contraseña: ' p12_password_repeat
printf '\n'
[[ -n "$p12_password" && "$p12_password" == "$p12_password_repeat" ]] || fail 'PASSWORD_CONFIRMATION_FAILED'
unset p12_password_repeat

openssl pkcs12 -legacy -in "$source_p12" -clcerts -nokeys -out "$work/leaf.pem" \
  -passin fd:3 3<<<"$p12_password" 2>/dev/null || fail 'P12_CERTIFICATE_EXTRACTION_FAILED'
openssl pkcs12 -legacy -in "$source_p12" -nocerts -nodes -out "$work/private.pem" \
  -passin fd:3 3<<<"$p12_password" 2>/dev/null || fail 'P12_PRIVATE_KEY_EXTRACTION_FAILED'

subject=$(openssl x509 -in "$work/leaf.pem" -noout -subject -nameopt RFC2253)
[[ "$subject" == *"serialNumber=IDCDO-$expected_rnc"* ]] || fail 'CERTIFICATE_RNC_MISMATCH'
leaf_fingerprint=$(openssl x509 -in "$work/leaf.pem" -noout -fingerprint -sha256 \
  | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')
[[ "$leaf_fingerprint" == "$expected_leaf_fingerprint" ]] || fail 'LEAF_FINGERPRINT_MISMATCH'
openssl x509 -in "$work/leaf.pem" -checkend 0 -noout >/dev/null || fail 'CERTIFICATE_EXPIRED'
key_usage=$(openssl x509 -in "$work/leaf.pem" -noout -ext keyUsage 2>/dev/null || true)
[[ "$key_usage" == *'Digital Signature'* && "$key_usage" != *'Certificate Sign'* ]] \
  || fail 'CERTIFICATE_KEY_USAGE_INVALID'
openssl x509 -in "$work/leaf.pem" -pubkey -noout \
  | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1 >"$work/leaf-public.sha256"
openssl pkey -in "$work/private.pem" -pubout -outform DER 2>/dev/null \
  | sha256sum | cut -d' ' -f1 >"$work/key-public.sha256"
cmp -s "$work/leaf-public.sha256" "$work/key-public.sha256" || fail 'PRIVATE_KEY_CERTIFICATE_MISMATCH'

curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --output "$work/root.crt" https://digi.camarasantodomingo.do/Cadena/digifirmaCARaiz.crt
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --output "$work/subordinate.crt" https://digi.camarasantodomingo.do/Cadena/digifirmaCASubordinada.crt
root_sha1=$(openssl x509 -in "$work/root.crt" -noout -fingerprint -sha1 \
  | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')
subordinate_sha1=$(openssl x509 -in "$work/subordinate.crt" -noout -fingerprint -sha1 \
  | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')
[[ "$root_sha1" == "$expected_root_sha1" ]] || fail 'DIGIFIRMA_ROOT_FINGERPRINT_MISMATCH'
[[ "$subordinate_sha1" == "$expected_subordinate_sha1" ]] || fail 'DIGIFIRMA_SUBORDINATE_FINGERPRINT_MISMATCH'
openssl verify -purpose any -CAfile "$work/root.crt" -untrusted "$work/subordinate.crt" \
  "$work/leaf.pem" >/dev/null || fail 'CERTIFICATE_CHAIN_INVALID'

curl --fail --silent --show-error --proto '=http' --max-redirs 0 \
  --output "$work/subordinate.crl.der" http://crl1.camarasantodomingo.do/public/pki/crl/CCPSD.crl
openssl crl -inform DER -in "$work/subordinate.crl.der" -out "$work/subordinate.crl.pem"
openssl crl -in "$work/subordinate.crl.pem" -noout -verify -CAfile "$work/subordinate.crt" >/dev/null \
  || fail 'CRL_SIGNATURE_INVALID'
openssl verify -purpose any -crl_check -CAfile "$work/root.crt" -untrusted "$work/subordinate.crt" \
  -CRLfile "$work/subordinate.crl.pem" "$work/leaf.pem" >/dev/null || fail 'CERTIFICATE_REVOKED_OR_CRL_INVALID'

install -d -o root -g root -m 0700 "$work/publish-secret"
install -o root -g root -m 0400 "$source_p12" "$work/publish-secret/certificate.p12"
printf '%s' "$p12_password" >"$work/publish-secret/password"
chmod 0400 "$work/publish-secret/password"
unset p12_password
install -o root -g root -m 0444 "$work/leaf.pem" "$work/publish-secret/certificate.pem"
cat >"$work/publish-secret/manifest.txt" <<EOF
RNC=$expected_rnc
SHA256=$expected_leaf_fingerprint
SERIAL=$(openssl x509 -in "$work/leaf.pem" -noout -serial | cut -d= -f2)
NOT_BEFORE=$(openssl x509 -in "$work/leaf.pem" -noout -startdate | cut -d= -f2-)
NOT_AFTER=$(openssl x509 -in "$work/leaf.pem" -noout -enddate | cut -d= -f2-)
ISSUER=$(openssl x509 -in "$work/leaf.pem" -noout -issuer -nameopt RFC2253 | sed 's/^issuer=//')
EOF
chmod 0444 "$work/publish-secret/manifest.txt"

install -d -o root -g corestack-admins -m 2750 "$public_dir"
install -o root -g corestack-admins -m 0444 "$work/root.crt" "$public_dir/root.crt"
install -o root -g corestack-admins -m 0444 "$work/subordinate.crt" "$public_dir/subordinate.crt"
install -o root -g corestack-admins -m 0444 "$work/subordinate.crl.pem" "$public_dir/subordinate.crl.pem"
mv "$work/publish-secret" "$destination_dir"

echo 'RIVNU_SIGNING_CERTIFICATE_PROVISIONED_NOT_ACTIVATED'
echo "Fingerprint SHA-256: $expected_leaf_fingerprint"
echo 'Secrets: root-only; password and private key contents not displayed.'
echo 'No containers, databases, DGII endpoints, queues or production settings changed.'
echo "Original upload retained at: $source_p12"
