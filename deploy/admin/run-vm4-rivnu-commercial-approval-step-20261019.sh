#!/usr/bin/env bash
# Submit exactly one signed commercial approval, or report completion.
set -euo pipefail
umask 077

readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly config='/home/luismel/fiscal-signer.rivnu-certification.json'
readonly signed='/home/luismel/rivnu-commercial-approval-signed-20261019'
readonly evidence='/home/luismel/rivnu-commercial-approval-evidence-20261019'
readonly runner='/home/luismel/submit-commercial-approval-set-20261019.ts'
readonly dgii_client='/home/luismel/dgii-client-commercial-approval-20261019.ts'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly report_sha='1e040117d49277459de2c411f64fcd8bccd3f4df9bb607a46679f5ad185cc5ec'
readonly runner_sha='5a2db5fdcf3d0df56d52ec78447cb9b93990878d7f8d37c10eefa16ca357c0a1'
readonly dgii_client_sha='2347ab997116f52c257f5619c4b31a614b8bd0469ee5fd3f665110351f44de56'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# -eq 0 ]] || fail 'INVALID_COMMERCIAL_APPROVAL_STEP_ARGUMENT'
[[ -d "$signed/acecf-signed" && -f "$signed/signing-report.json" && ! -L "$signed" ]] || fail 'SIGNED_COMMERCIAL_APPROVAL_SET_MISSING'
[[ "$(sha256sum "$signed/signing-report.json" | cut -d' ' -f1)" == "$report_sha" ]] || fail 'COMMERCIAL_APPROVAL_REPORT_HASH_MISMATCH'
[[ "$(find "$signed/acecf-signed" -maxdepth 1 -type f -name 'ACECF-E*.xml' | wc -l)" -eq 11 ]] || fail 'SIGNED_COMMERCIAL_APPROVAL_COUNT_INVALID'
[[ -f "$config" && ! -L "$config" ]] || fail 'CERTIFICATION_CONFIG_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'COMMERCIAL_APPROVAL_RUNNER_INVALID'
[[ -f "$dgii_client" && ! -L "$dgii_client" && "$(sha256sum "$dgii_client" | cut -d' ' -f1)" == "$dgii_client_sha" ]] || fail 'DGII_CLIENT_INVALID'
docker image inspect "$image" >/dev/null || fail 'CERTIFICATION_SIGNER_IMAGE_MISSING'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done

install -d -o root -g 4101 -m 0770 "$evidence"
work=$(mktemp -d /opt/corestack/secrets/.commercial-approval-delivery.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/signed" "$work/signed/acecf-signed"
install -o root -g 4101 -m 0440 "$signed/signing-report.json" "$work/signed/signing-report.json"
for file in "$signed"/acecf-signed/ACECF-E*.xml; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'SIGNED_COMMERCIAL_APPROVAL_INVALID'
  install -o root -g 4101 -m 0440 "$file" "$work/signed/acecf-signed/${file##*/}"
done
[[ "$(find "$work/signed/acecf-signed" -maxdepth 1 -type f -name 'ACECF-E*.xml' | wc -l)" -eq 11 ]] || fail 'SIGNED_COMMERCIAL_APPROVAL_COUNT_INVALID'

docker run --rm --network fiscal-network --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$config:/run/config/fiscal-signer.json:ro" \
  -v "$runner:/app/fiscal/src/submit-commercial-approval-set.ts:ro" \
  -v "$dgii_client:/app/fiscal/src/dgii-client.ts:ro" \
  -v "$work/signed:/signed:ro" \
  -v "$evidence:/evidence" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/submit-commercial-approval-set.ts
