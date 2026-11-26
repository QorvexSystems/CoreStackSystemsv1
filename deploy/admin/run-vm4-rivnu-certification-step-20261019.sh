#!/usr/bin/env bash
# One safe step for RIVNU's second certification attempt: reconcile first or POST once.
set -euo pipefail
umask 077

readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly config='/home/luismel/fiscal-signer.rivnu-certification.json'
readonly signed='/home/luismel/rivnu-certification-set-signed-20261019-attempt2'
readonly prior_signed='/home/luismel/rivnu-certification-set-signed-20261019'
readonly evidence='/home/luismel/rivnu-certification-evidence-20261019-attempt2'
readonly runner='/home/luismel/submit-certification-set-20261019-attempt2.ts'
readonly plan='/home/luismel/certification-set-plan-20261019.ts'
readonly xml_runtime='/home/luismel/fiscal-xml-20261019.ts'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly report_sha='eb1800d6a22c7483df037886245eba9b84de0d700ff381e9800473344e93ef04'
readonly prior_report_sha='51c425b7cb6d5c4ff65bb2410531bdfe598ee5ba50bd09fd21e568019921fa9f'
readonly runner_sha='7cbb72e13ec17bf004b3971937b6d74c0f80c33ded64ecf034e5f6077391b312'
readonly plan_sha='7e2a45235a194fcf3d25ce8da81a6c46cac73b19699325ad183bc021e2b8ea85'
readonly xml_runtime_sha='b054eecf34efdde08a621fe8f2e3bff2744a5eb45b4d3be78f8abb665919cc68'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# -eq 0 ]] || fail 'INVALID_CERTIFICATION_STEP_ARGUMENT'
[[ -d "$signed/ecf-signed" && -d "$signed/rfce-signed" && -f "$signed/signing-report.json" ]] || fail 'SIGNED_SET_MISSING'
[[ "$(sha256sum "$signed/signing-report.json" | cut -d' ' -f1)" == "$report_sha" ]] || fail 'SIGNING_REPORT_HASH_MISMATCH'
[[ -f "$prior_signed/signing-report.json" && "$(sha256sum "$prior_signed/signing-report.json" | cut -d' ' -f1)" == "$prior_report_sha" ]] || fail 'PRIOR_SIGNING_REPORT_INVALID'
[[ -f "$config" && ! -L "$config" ]] || fail 'CERTIFICATION_CONFIG_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'CERTIFICATION_RUNNER_INVALID'
[[ -f "$plan" && ! -L "$plan" && "$(sha256sum "$plan" | cut -d' ' -f1)" == "$plan_sha" ]] || fail 'CERTIFICATION_PLAN_INVALID'
[[ -f "$xml_runtime" && ! -L "$xml_runtime" && "$(sha256sum "$xml_runtime" | cut -d' ' -f1)" == "$xml_runtime_sha" ]] || fail 'CERTIFICATION_XML_RUNTIME_INVALID'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done

python3 - "$prior_signed/signing-report.json" "$signed/signing-report.json" <<'PY' \
  || fail 'RFCE_SECURITY_CODE_REUSED_FROM_PRIOR_ATTEMPT'
import json
import sys

prior = json.load(open(sys.argv[1], encoding="utf-8"))
current = json.load(open(sys.argv[2], encoding="utf-8"))
prior_pairs = {(item["encf"], item["securityCode"]) for item in prior["rfce"]}
current_pairs = {(item["encf"], item["securityCode"]) for item in current["rfce"]}
if prior_pairs & current_pairs:
    raise SystemExit(1)
PY

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
  "$image" node --experimental-strip-types src/submit-certification-set.ts
