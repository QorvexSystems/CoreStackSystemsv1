#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly source_p12='/home/luismel/rivnu-certificate-upload.d3IH5U/rivnu.p12'
[[ -f "$source_p12" && ! -L "$source_p12" ]] || { echo 'P12_NOT_FOUND' >&2; exit 1; }
[[ "$(stat -c '%U:%G:%a' "$source_p12")" == 'luismel:luismel:600' ]] || {
  echo 'P12_PERMISSIONS_INVALID' >&2; exit 1;
}

work=$(mktemp -d /home/luismel/rivnu-p12-audit.XXXXXX)
trap 'unset p12_password; rm -rf -- "$work"' EXIT
stage='INITIALIZATION'
trap 'code=$?; if (( code != 0 )); then printf "P12_AUDIT_FAILED_STAGE_%s\n" "$stage" >&2; fi; unset p12_password; rm -rf -- "$work"; exit $code' EXIT

read -r -s -p 'Contraseña del certificado (no se mostrará): ' p12_password
printf '\n'
[[ -n "$p12_password" ]] || { echo 'EMPTY_PASSWORD' >&2; exit 1; }

stage='CERTIFICATE_EXTRACTION'
openssl pkcs12 -legacy -in "$source_p12" -clcerts -nokeys -out "$work/certificate.pem" \
  -passin fd:3 3<<<"$p12_password" 2>"$work/certificate-error.log" || {
    if grep -qi 'invalid password\|mac verify error' "$work/certificate-error.log"; then
      echo 'P12_PASSWORD_REJECTED' >&2
    else
      echo 'P12_CERTIFICATE_EXTRACTION_FAILED' >&2
    fi
    exit 1
  }
[[ -s "$work/certificate.pem" ]] || { echo 'P12_CLIENT_CERTIFICATE_NOT_FOUND' >&2; exit 1; }
stage='PRIVATE_KEY_EXTRACTION'
openssl pkcs12 -in "$source_p12" -nocerts -nodes -out "$work/private-key.pem" \
  -legacy -passin fd:3 3<<<"$p12_password" 2>"$work/key-error.log" || {
    if grep -qi 'invalid password\|mac verify error' "$work/key-error.log"; then
      echo 'P12_PASSWORD_REJECTED' >&2
    else
      echo 'P12_PRIVATE_KEY_EXTRACTION_FAILED' >&2
    fi
    exit 1
  }
unset p12_password
[[ -s "$work/private-key.pem" ]] || { echo 'P12_PRIVATE_KEY_NOT_FOUND' >&2; exit 1; }
chmod 600 "$work/private-key.pem" "$work/certificate.pem"

stage='CERTIFICATE_VALIDITY'
openssl x509 -in "$work/certificate.pem" -checkend 0 -noout >/dev/null || {
  echo 'CERTIFICATE_EXPIRED_OR_NOT_YET_VALID' >&2; exit 1;
}
subject=$(openssl x509 -in "$work/certificate.pem" -noout -subject -nameopt RFC2253)
[[ "$subject" == *'serialNumber=IDCDO-40220429126'* ]] || {
  echo 'CERTIFICATE_RNC_MISMATCH' >&2; exit 1;
}
basic_constraints=$(openssl x509 -in "$work/certificate.pem" -noout -ext basicConstraints 2>/dev/null || true)
if [[ "$basic_constraints" == *'CA:TRUE'* ]]; then
  echo 'CERTIFICATE_IS_CA' >&2; exit 1
elif [[ "$basic_constraints" != *'CA:FALSE'* ]]; then
  echo 'NOTICE_BASIC_CONSTRAINTS_EXTENSION_NOT_PRESENT'
fi
key_usage=$(openssl x509 -in "$work/certificate.pem" -noout -ext keyUsage 2>/dev/null || true)
[[ "$key_usage" == *'Digital Signature'* ]] || {
  echo 'CERTIFICATE_MISSING_DIGITAL_SIGNATURE_USAGE' >&2; exit 1;
}
[[ "$key_usage" != *'Certificate Sign'* ]] || {
  echo 'CERTIFICATE_ALLOWS_CERTIFICATE_SIGNING' >&2; exit 1;
}

stage='TRUST_CHAIN_DOWNLOAD'
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --output "$work/root.crt" https://digi.camarasantodomingo.do/Cadena/digifirmaCARaiz.crt
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-redirs 0 \
  --output "$work/subordinate.crt" https://digi.camarasantodomingo.do/Cadena/digifirmaCASubordinada.crt
root_fingerprint=$(openssl x509 -in "$work/root.crt" -noout -fingerprint -sha1 \
  | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')
subordinate_fingerprint=$(openssl x509 -in "$work/subordinate.crt" -noout -fingerprint -sha1 \
  | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')
[[ "$root_fingerprint" == 'd6ea339754cf4b6f41526a8e2a65a273575fe8fa' ]] || {
  echo 'DIGIFIRMA_ROOT_FINGERPRINT_MISMATCH' >&2; exit 1;
}
[[ "$subordinate_fingerprint" == '8d42a1098951a508d5ea1daa2a16958d348989cc' ]] || {
  echo 'DIGIFIRMA_SUBORDINATE_FINGERPRINT_MISMATCH' >&2; exit 1;
}
stage='TRUST_CHAIN_VERIFICATION'
openssl verify -CAfile "$work/root.crt" "$work/root.crt" >/dev/null
openssl verify -CAfile "$work/root.crt" "$work/subordinate.crt" >/dev/null
openssl verify -purpose any -CAfile "$work/root.crt" -untrusted "$work/subordinate.crt" \
  "$work/certificate.pem" >/dev/null

stage='REVOCATION_LIST_VERIFICATION'
curl --fail --silent --show-error --proto '=http' --max-redirs 0 \
  --output "$work/subordinate.crl.der" http://crl1.camarasantodomingo.do/public/pki/crl/CCPSD.crl
openssl crl -inform DER -in "$work/subordinate.crl.der" -out "$work/subordinate.crl.pem"
openssl crl -in "$work/subordinate.crl.pem" -noout -verify \
  -CAfile "$work/subordinate.crt" >/dev/null
openssl verify -purpose any -crl_check -CAfile "$work/root.crt" \
  -untrusted "$work/subordinate.crt" -CRLfile "$work/subordinate.crl.pem" \
  "$work/certificate.pem" >/dev/null
stage='PUBLIC_KEY_MATCH'
openssl x509 -in "$work/certificate.pem" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null \
  | sha256sum | cut -d' ' -f1 >"$work/cert-public.sha256"
openssl pkey -in "$work/private-key.pem" -pubout -outform DER 2>/dev/null \
  | sha256sum | cut -d' ' -f1 >"$work/key-public.sha256"
cmp -s "$work/cert-public.sha256" "$work/key-public.sha256" || {
  echo 'PRIVATE_KEY_CERTIFICATE_MISMATCH' >&2; exit 1;
}

stage='PUBLIC_METADATA'
echo 'CERTIFICATE_CONTAINER_VALID'
echo 'PRIVATE_KEY_MATCHES_CERTIFICATE'
echo 'DIGIFIRMA_CHAIN_VERIFIED_WITH_PINNED_ROOT_AND_SUBORDINATE'
echo 'CERTIFICATE_NOT_REVOKED_IN_CURRENT_SIGNED_CRL'
openssl x509 -in "$work/certificate.pem" -noout \
  -subject -issuer -serial -dates -fingerprint -sha256
echo 'Public certificate purposes:'
openssl x509 -in "$work/certificate.pem" -noout -purpose
echo 'Public certificate extensions relevant to trust and revocation:'
for extension in basicConstraints keyUsage extendedKeyUsage certificatePolicies authorityInfoAccess crlDistributionPoints; do
  openssl x509 -in "$work/certificate.pem" -noout -ext "$extension" 2>/dev/null || true
done
openssl crl -in "$work/subordinate.crl.pem" -noout -lastupdate -nextupdate
echo 'AUDIT_COMPLETE_NO_INSTALLATION_NO_ACTIVATION'
stage='COMPLETE'
