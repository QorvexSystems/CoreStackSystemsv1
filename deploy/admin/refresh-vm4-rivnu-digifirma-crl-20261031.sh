#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly runtime=/opt/corestack/secrets/rivnu-signer-runtime
readonly public_trust=/opt/corestack/fe/config/trust/digifirma
readonly expected_leaf_sha256=a4348bad3005f70073f5d048d7789a9f9289addb3004ca84319feb1e5f41012d
readonly crl_url=http://crl1.camarasantodomingo.do/public/pki/crl/CCPSD.crl

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] ||
  fail RUN_WITH_SUDO_ON_VM4

for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail SIGNER_RUNTIME_INVALID
done
[[ -f "$public_trust/subordinate.crl.pem" && ! -L "$public_trust/subordinate.crl.pem" ]] ||
  fail PUBLIC_CRL_INVALID

readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup="/opt/corestack/backups/digifirma-crl-refresh-$timestamp"
[[ ! -e "$backup" && ! -L "$backup" ]] || fail BACKUP_ALREADY_EXISTS

work="$(mktemp -d /opt/corestack/secrets/.digifirma-crl-refresh.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT

# The distribution URL is HTTP, but the CRL is accepted only after its
# cryptographic signature is verified with the pinned DigiFirma subordinate.
curl --fail --silent --show-error --proto '=http' --max-redirs 0 \
  --connect-timeout 10 --max-time 30 \
  --output "$work/subordinate.crl.der" "$crl_url"
openssl crl -inform DER -in "$work/subordinate.crl.der" -out "$work/subordinate.crl.pem"
openssl crl -in "$work/subordinate.crl.pem" -noout -verify \
  -CAfile "$runtime/subordinate.crt" >/dev/null || fail CRL_SIGNATURE_INVALID

last_update="$(openssl crl -in "$work/subordinate.crl.pem" -noout -lastupdate | cut -d= -f2-)"
next_update="$(openssl crl -in "$work/subordinate.crl.pem" -noout -nextupdate | cut -d= -f2-)"
now_epoch="$(date -u +%s)"
last_epoch="$(date -u -d "$last_update" +%s)" || fail CRL_LAST_UPDATE_INVALID
next_epoch="$(date -u -d "$next_update" +%s)" || fail CRL_NEXT_UPDATE_INVALID
(( last_epoch <= now_epoch && next_epoch > now_epoch )) || fail CRL_NOT_CURRENT

openssl pkcs12 -legacy -in "$runtime/certificate.p12" -clcerts -nokeys \
  -out "$work/leaf.pem" -passin "file:$runtime/certificate.password" 2>/dev/null ||
  fail CERTIFICATE_EXTRACTION_FAILED
leaf_sha256="$(openssl x509 -in "$work/leaf.pem" -noout -fingerprint -sha256 |
  cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"
[[ "$leaf_sha256" == "$expected_leaf_sha256" ]] || fail LEAF_FINGERPRINT_MISMATCH
openssl verify -purpose any -crl_check -CAfile "$runtime/root.crt" \
  -untrusted "$runtime/subordinate.crt" -CRLfile "$work/subordinate.crl.pem" \
  "$work/leaf.pem" >/dev/null || fail CERTIFICATE_REVOKED_OR_CRL_INVALID

install -d -o root -g root -m 0700 "$backup"
install -o root -g root -m 0600 "$runtime/subordinate.crl.pem" "$backup/runtime-subordinate.crl.pem"
install -o root -g root -m 0600 "$public_trust/subordinate.crl.pem" "$backup/public-subordinate.crl.pem"
install -o root -g 4101 -m 0440 "$work/subordinate.crl.pem" "$runtime/subordinate.crl.pem.new"
install -o root -g corestack-admins -m 0444 "$work/subordinate.crl.pem" "$public_trust/subordinate.crl.pem.new"
mv -f -- "$runtime/subordinate.crl.pem.new" "$runtime/subordinate.crl.pem"
mv -f -- "$public_trust/subordinate.crl.pem.new" "$public_trust/subordinate.crl.pem"

runtime_sha="$(sha256sum "$runtime/subordinate.crl.pem" | cut -d' ' -f1)"
public_sha="$(sha256sum "$public_trust/subordinate.crl.pem" | cut -d' ' -f1)"
[[ "$runtime_sha" == "$public_sha" ]] || fail CRL_PUBLISHED_COPIES_DIFFER

printf 'RIVNU_DIGIFIRMA_CURRENT_SIGNED_CRL_INSTALLED\n'
printf 'lastUpdate=%s\nnextUpdate=%s\nSHA-256=%s\nBackup=%s\n' \
  "$last_update" "$next_update" "$runtime_sha" "$backup"
printf 'No certificate, private key, database, queue, container or DGII endpoint was changed.\n'
