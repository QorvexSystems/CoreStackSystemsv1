#!/usr/bin/env bash
# Sign the exact portal-generated postulation offline. Original remains unchanged.
set -euo pipefail
umask 077
readonly source='/home/luismel/rivnu-postulacion-84014-v2/postulacion.xml'
readonly destination='/home/luismel/rivnu-postulacion-84014-v2/postulacion-firmada-preservewhitespace-false.xml'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly image='corestack/fiscal-signer:postulation-whitespace-fix'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -f "$source" && ! -L "$source" && "$(stat -c '%U:%G:%a' "$source")" == 'luismel:luismel:600' ]] || fail 'POSTULATION_SOURCE_INVALID'
[[ "$(sha256sum "$source" | cut -d' ' -f1)" == '739eb40239b7772fd68faa93ccd08e9e6750278fd80b1339056a74555dd6ca1c' ]] || fail 'POSTULATION_SOURCE_HASH_MISMATCH'
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'SIGNED_POSTULATION_ALREADY_EXISTS_NO_OVERWRITE'
docker image inspect "$image" >/dev/null || fail 'SIGNER_IMAGE_MISSING'
work=$(mktemp -d /opt/corestack/secrets/.postulation-signing.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/input"
install -d -o root -g 4101 -m 0770 "$work/output"
install -o root -g 4101 -m 0440 "$source" "$work/input/postulacion.xml"
docker run --rm --network none --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$work/input:/input:ro" -v "$work/output:/output" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/sign-postulation.ts
[[ -f "$work/output/postulacion-firmada.xml" && ! -L "$work/output/postulacion-firmada.xml" ]] || fail 'SIGNED_POSTULATION_OUTPUT_MISSING'
install -o luismel -g luismel -m 0600 "$work/output/postulacion-firmada.xml" "$destination"
echo 'SIGNED_POSTULATION_READY_FOR_PORTAL_UPLOAD'
sha256sum "$destination"
echo 'Original portal XML retained unchanged; no DGII request was made.'
