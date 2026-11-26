#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly bundle=/home/luismel/rivnu-sworn-declaration-20261020
readonly source="$bundle/declaracion-jurada-rivnu-20261020.xml"
readonly destination="$bundle/declaracion-jurada-rivnu-firmada.xml"
readonly source_sha256=98e27b87ff9219c490c748a2e0f579ac1bcddae0b43cc15d061cc15ff7764164
readonly runtime=/opt/corestack/secrets/rivnu-signer-runtime
readonly image=corestack/fiscal-signer:sworn-declaration-rivnu-20261020
readonly expected_image_id=sha256:4e49cc5ef3fc2871bea3f9ef61008082656249c47dc6d0a450ca7b95e67ba713

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
[[ -f "$source" && ! -L "$source" ]] || fail DECLARATION_SOURCE_INVALID
[[ "$(sha256sum "$source" | cut -d ' ' -f 1)" == "$source_sha256" ]] || fail DECLARATION_SOURCE_HASH_MISMATCH
[[ ! -e "$destination" && ! -L "$destination" ]] || fail SIGNED_DECLARATION_ALREADY_EXISTS_NO_OVERWRITE
[[ "$(docker image inspect "$image" --format '{{.Id}}')" == "$expected_image_id" ]] || fail SIGNER_IMAGE_ID_MISMATCH
for path in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$path" && ! -L "$runtime/$path" ]] || fail "SIGNER_RUNTIME_MISSING_$path"
done

readonly work="$(mktemp -d /opt/corestack/secrets/.rivnu-declaration-signing.XXXXXX)"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/input"
install -d -o root -g 4101 -m 0770 "$work/output"
install -o root -g 4101 -m 0440 "$source" "$work/input/declaracion-jurada.xml"

docker run --rm --network none --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$work/input:/input:ro" -v "$work/output:/output" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/sign-rivnu-sworn-declaration.ts

[[ -f "$work/output/declaracion-jurada-firmada.xml" && ! -L "$work/output/declaracion-jurada-firmada.xml" ]] ||
  fail SIGNED_DECLARATION_OUTPUT_MISSING
install -o luismel -g luismel -m 0600 "$work/output/declaracion-jurada-firmada.xml" "$destination"
printf 'RIVNU_SWORN_DECLARATION_READY_FOR_PORTAL_UPLOAD\n'
sha256sum "$destination"
printf 'Original declaration retained unchanged; no DGII request was made.\n'
