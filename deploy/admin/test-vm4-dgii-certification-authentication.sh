#!/usr/bin/env bash
# Certification authentication only. No database access or fiscal submission.
set -euo pipefail
readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly config='/home/luismel/fiscal-signer.rivnu-certification.json'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -f "$config" && ! -L "$config" ]] || fail 'CERTIFICATION_CONFIG_MISSING'
docker image inspect "$image" >/dev/null || fail 'CERTIFICATION_SIGNER_IMAGE_MISSING'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done
docker run --rm --network fiscal-network --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$config:/run/config/fiscal-signer.json:ro" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/dgii-auth-smoke.ts
echo 'DGII_CERTIFICATION_AUTH_SMOKE_COMPLETE_NO_FISCAL_DOCUMENT_SUBMITTED'
