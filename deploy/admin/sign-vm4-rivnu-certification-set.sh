#!/usr/bin/env bash
# Offline batch signing of the exact DGII-assigned certification set.
set -euo pipefail
umask 077
readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly source='/home/luismel/rivnu-certification-set-input-v2-20261006'
readonly runner='/home/luismel/sign-certification-set.ts'
readonly xml_runtime='/home/luismel/fiscal-xml.ts'
readonly destination='/home/luismel/rivnu-certification-set-signed-20261006'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly manifest_sha='a3ca9445db1bec69578354748a42299bea8f4638d7e13091984ba8c87a3f496e'
readonly runner_sha='1e0dbd16c40c59bcaf6d4cba8edf1125627dab004212259558a443a854094f65'
readonly xml_runtime_sha='b054eecf34efdde08a621fe8f2e3bff2744a5eb45b4d3be78f8abb665919cc68'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -d "$source/ecf-unsigned" && -f "$source/manifest.json" && ! -L "$source" ]] || fail 'CERTIFICATION_SET_INPUT_MISSING'
[[ "$(sha256sum "$source/manifest.json" | cut -d' ' -f1)" == "$manifest_sha" ]] || fail 'CERTIFICATION_MANIFEST_HASH_MISMATCH'
[[ "$(find "$source/ecf-unsigned" -maxdepth 1 -type f -name 'E*.xml' | wc -l)" -eq 25 ]] || fail 'CERTIFICATION_CASE_COUNT_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'CERTIFICATION_RUNNER_INVALID'
[[ -f "$xml_runtime" && ! -L "$xml_runtime" && "$(sha256sum "$xml_runtime" | cut -d' ' -f1)" == "$xml_runtime_sha" ]] || fail 'CERTIFICATION_XML_RUNTIME_INVALID'
[[ ! -e "$destination" && ! -L "$destination" ]] || fail 'CERTIFICATION_SIGNED_OUTPUT_ALREADY_EXISTS'
docker image inspect "$image" >/dev/null || fail 'CERTIFICATION_SIGNER_IMAGE_MISSING'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done
work=$(mktemp -d /opt/corestack/secrets/.certification-set-signing.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/input" "$work/input/ecf-unsigned"
install -d -o root -g 4101 -m 0770 "$work/output"
install -o root -g 4101 -m 0440 "$source/manifest.json" "$work/input/manifest.json"
for file in "$source"/ecf-unsigned/E*.xml; do
  install -o root -g 4101 -m 0440 "$file" "$work/input/ecf-unsigned/${file##*/}"
done
docker run --rm --network none --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$runner:/app/fiscal/src/sign-certification-set.ts:ro" \
  -v "$xml_runtime:/app/fiscal/src/xml.ts:ro" \
  -v "$work/input:/input:ro" -v "$work/output:/output" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/sign-certification-set.ts
[[ "$(find "$work/output/ecf-signed" -maxdepth 1 -type f -name 'E*.xml' | wc -l)" -eq 25 ]] || fail 'SIGNED_ECF_COUNT_INVALID'
[[ "$(find "$work/output/rfce-signed" -maxdepth 1 -type f -name 'RFCE-E*.xml' | wc -l)" -eq 4 ]] || fail 'SIGNED_RFCE_COUNT_INVALID'
install -d -o luismel -g luismel -m 0700 "$destination" "$destination/ecf-signed" "$destination/rfce-signed"
for file in "$work/output/ecf-signed"/*.xml; do install -o luismel -g luismel -m 0600 "$file" "$destination/ecf-signed/${file##*/}"; done
for file in "$work/output/rfce-signed"/*.xml; do install -o luismel -g luismel -m 0600 "$file" "$destination/rfce-signed/${file##*/}"; done
install -o luismel -g luismel -m 0600 "$work/output/signing-report.json" "$destination/signing-report.json"
echo 'RIVNU_CERTIFICATION_SIGNED_SET_READY_NOT_SUBMITTED'
sha256sum "$destination/signing-report.json"
