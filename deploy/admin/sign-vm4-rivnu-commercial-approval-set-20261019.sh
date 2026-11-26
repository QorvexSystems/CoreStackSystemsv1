#!/usr/bin/env bash
# Offline signing of RIVNU's exact DGII commercial-approval certification set.
set -euo pipefail
umask 077

readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly source='/home/luismel/rivnu-commercial-approval-input-20261019'
readonly runner='/home/luismel/sign-commercial-approval-set-20261019.ts'
readonly destination='/home/luismel/rivnu-commercial-approval-signed-20261019'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly manifest_sha='63e272336b05c6b00065f9a6f0a2313fb078529087340a0eed32fd0d74f962da'
readonly runner_sha='f7bdff20de0cc2f887dcb146f9015f5a48e3037a9bf351866ffd3846348863e5'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -d "$source/acecf-unsigned" && -f "$source/manifest.json" && ! -L "$source" ]] || fail 'COMMERCIAL_APPROVAL_INPUT_MISSING'
[[ "$(sha256sum "$source/manifest.json" | cut -d' ' -f1)" == "$manifest_sha" ]] || fail 'COMMERCIAL_APPROVAL_MANIFEST_HASH_MISMATCH'
[[ "$(find "$source/acecf-unsigned" -maxdepth 1 -type f -name 'ACECF-E*.xml' | wc -l)" -eq 11 ]] || fail 'COMMERCIAL_APPROVAL_CASE_COUNT_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'COMMERCIAL_APPROVAL_RUNNER_INVALID'
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'COMMERCIAL_APPROVAL_SIGNED_OUTPUT_ALREADY_EXISTS'
docker image inspect "$image" >/dev/null || fail 'CERTIFICATION_SIGNER_IMAGE_MISSING'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done

work=$(mktemp -d /opt/corestack/secrets/.commercial-approval-signing.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/input" "$work/input/acecf-unsigned"
install -d -o root -g 4101 -m 0770 "$work/output"
install -o root -g 4101 -m 0440 "$source/manifest.json" "$work/input/manifest.json"
for file in "$source"/acecf-unsigned/ACECF-E*.xml; do
  install -o root -g 4101 -m 0440 "$file" "$work/input/acecf-unsigned/${file##*/}"
done

docker run --rm --network none --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$runner:/app/fiscal/src/sign-commercial-approval-set.ts:ro" \
  -v "$work/input:/input:ro" -v "$work/output:/output" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/sign-commercial-approval-set.ts

[[ "$(find "$work/output/acecf-signed" -maxdepth 1 -type f -name 'ACECF-E*.xml' | wc -l)" -eq 11 ]] || fail 'SIGNED_COMMERCIAL_APPROVAL_COUNT_INVALID'
install -d -o luismel -g luismel -m 0700 "$destination" "$destination/acecf-signed"
for file in "$work/output/acecf-signed"/*.xml; do
  install -o luismel -g luismel -m 0600 "$file" "$destination/acecf-signed/${file##*/}"
done
install -o luismel -g luismel -m 0600 "$work/output/signing-report.json" "$destination/signing-report.json"

echo 'RIVNU_COMMERCIAL_APPROVAL_SIGNED_SET_READY_NOT_SUBMITTED'
sha256sum "$destination/signing-report.json"
