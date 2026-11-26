#!/usr/bin/env bash
# One safe certification state-machine step: reconcile first, otherwise one POST.
set -euo pipefail
umask 077
readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly config='/home/luismel/fiscal-signer.rivnu-certification.json'
readonly signed='/home/luismel/rivnu-certification-set-signed-20261006'
readonly evidence='/home/luismel/rivnu-certification-evidence-20261006'
readonly runner='/home/luismel/submit-certification-set.ts'
readonly plan='/home/luismel/certification-set-plan.ts'
readonly xml_runtime='/home/luismel/fiscal-xml.ts'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly runner_sha='1867e8f79c93ff4c15b5ad4d5c4378b792f2fd3493e680a4342f41af3bf4338a'
readonly plan_sha='45140fcd2ddb45700df39894ee345e3f81708b666d8e8f55efe9123be59e4834'
readonly xml_runtime_sha='b054eecf34efdde08a621fe8f2e3bff2744a5eb45b4d3be78f8abb665919cc68'
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -d "$signed/ecf-signed" && -d "$signed/rfce-signed" && -f "$signed/signing-report.json" ]] || fail 'SIGNED_SET_MISSING'
[[ "$(sha256sum "$signed/signing-report.json" | cut -d' ' -f1)" == 'cf4cfd2121900d0724c5041f0315eb797c13284635182cbe61a4fc7362a2c502' ]] || fail 'SIGNING_REPORT_HASH_MISMATCH'
[[ -f "$config" && ! -L "$config" ]] || fail 'CERTIFICATION_CONFIG_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'CERTIFICATION_RUNNER_INVALID'
[[ -f "$plan" && ! -L "$plan" && "$(sha256sum "$plan" | cut -d' ' -f1)" == "$plan_sha" ]] || fail 'CERTIFICATION_PLAN_INVALID'
[[ -f "$xml_runtime" && ! -L "$xml_runtime" && "$(sha256sum "$xml_runtime" | cut -d' ' -f1)" == "$xml_runtime_sha" ]] || fail 'CERTIFICATION_XML_RUNTIME_INVALID'
recovery_args=()
if [[ $# -eq 1 && "$1" == 'recover-local-preflight-E320000000006' ]]; then
  recovery_args=(-e 'CERTIFICATION_RECOVER_LOCAL_PREFLIGHT=E320000000006')
elif [[ $# -ne 0 ]]; then
  fail 'INVALID_CERTIFICATION_STEP_ARGUMENT'
fi
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done
install -d -o root -g 4101 -m 0770 "$evidence"
work=$(mktemp -d /opt/corestack/secrets/.certification-delivery.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 \
  "$work/signed" "$work/signed/ecf-signed" "$work/signed/rfce-signed"
install -o root -g 4101 -m 0440 "$signed/signing-report.json" "$work/signed/signing-report.json"
for file in "$signed"/ecf-signed/E*.xml; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'SIGNED_ECF_INVALID'
  install -o root -g 4101 -m 0440 "$file" "$work/signed/ecf-signed/${file##*/}"
done
for file in "$signed"/rfce-signed/RFCE-E*.xml; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'SIGNED_RFCE_INVALID'
  install -o root -g 4101 -m 0440 "$file" "$work/signed/rfce-signed/${file##*/}"
done
[[ "$(find "$work/signed/ecf-signed" -maxdepth 1 -type f -name 'E*.xml' | wc -l)" -eq 25 ]] || fail 'SIGNED_ECF_COUNT_INVALID'
[[ "$(find "$work/signed/rfce-signed" -maxdepth 1 -type f -name 'RFCE-E*.xml' | wc -l)" -eq 4 ]] || fail 'SIGNED_RFCE_COUNT_INVALID'
docker run --rm --network fiscal-network --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  --tmpfs /run/seed-signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$config:/run/config/fiscal-signer.json:ro" \
  -v "$runner:/app/fiscal/src/submit-certification-set.ts:ro" \
  -v "$plan:/app/fiscal/src/certification-set-plan.ts:ro" \
  -v "$xml_runtime:/app/fiscal/src/xml.ts:ro" \
  -v "$work/signed:/signed:ro" -v "$evidence:/evidence" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "${recovery_args[@]}" \
  "$image" node --experimental-strip-types src/submit-certification-set.ts
