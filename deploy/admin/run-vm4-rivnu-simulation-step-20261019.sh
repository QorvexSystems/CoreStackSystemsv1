#!/usr/bin/env bash
# One safe simulation delivery step: reconcile first or POST exactly once.
set -euo pipefail
umask 077

readonly image='corestack/fiscal-signer:cert-route-20261006'
readonly config='/home/luismel/fiscal-signer.rivnu-certification.json'
readonly signed='/home/luismel/rivnu-simulation-signed-20261019'
readonly evidence='/home/luismel/rivnu-simulation-evidence-20261019'
readonly runner='/home/luismel/submit-rivnu-simulation-set-20261019.ts'
readonly plan='/home/luismel/rivnu-simulation-plan-20261019.ts'
readonly xml_runtime='/home/luismel/fiscal-xml-20261019.ts'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly report_sha='9a97614b010e3a08d0bc2d1316ce983157baaef24d10bc45d03e3d9ae5cca113'
readonly runner_sha='7eb91f6cdbc3eb4e95bc997620201d72d82e0dafdfcac6b166fb4f52d18e5f8d'
readonly plan_sha='b135968c50587c219cd908bcc78d0f55e3ff451513cd6f30dccd7cb32501f78e'
readonly xml_runtime_sha='b054eecf34efdde08a621fe8f2e3bff2744a5eb45b4d3be78f8abb665919cc68'

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ $# -eq 0 ]] || fail 'INVALID_SIMULATION_STEP_ARGUMENT'
[[ -d "$signed/ecf-signed" && -d "$signed/rfce-signed" && -f "$signed/signing-report.json" ]] || fail 'SIGNED_SIMULATION_SET_MISSING'
[[ "$(sha256sum "$signed/signing-report.json" | cut -d' ' -f1)" == "$report_sha" ]] || fail 'SIMULATION_REPORT_HASH_MISMATCH'
[[ "$(find "$signed/ecf-signed" -maxdepth 1 -type f -name 'E*.xml' | wc -l)" -eq 25 ]] || fail 'SIGNED_SIMULATION_ECF_COUNT_INVALID'
[[ "$(find "$signed/rfce-signed" -maxdepth 1 -type f -name 'RFCE-E*.xml' | wc -l)" -eq 4 ]] || fail 'SIGNED_SIMULATION_RFCE_COUNT_INVALID'
[[ -f "$config" && ! -L "$config" ]] || fail 'CERTIFICATION_CONFIG_INVALID'
[[ -f "$runner" && ! -L "$runner" && "$(sha256sum "$runner" | cut -d' ' -f1)" == "$runner_sha" ]] || fail 'SIMULATION_RUNNER_INVALID'
[[ -f "$plan" && ! -L "$plan" && "$(sha256sum "$plan" | cut -d' ' -f1)" == "$plan_sha" ]] || fail 'SIMULATION_PLAN_INVALID'
[[ -f "$xml_runtime" && ! -L "$xml_runtime" && "$(sha256sum "$xml_runtime" | cut -d' ' -f1)" == "$xml_runtime_sha" ]] || fail 'SIMULATION_XML_RUNTIME_INVALID'
docker image inspect "$image" >/dev/null || fail 'CERTIFICATION_SIGNER_IMAGE_MISSING'
for file in certificate.p12 certificate.password root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || fail 'SIGNER_RUNTIME_INVALID'
done

install -d -o root -g 4101 -m 0770 "$evidence"
work=$(mktemp -d /opt/corestack/secrets/.simulation-delivery.XXXXXX)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
install -d -o root -g 4101 -m 0550 "$work/signed" "$work/signed/ecf-signed" "$work/signed/rfce-signed"
install -o root -g 4101 -m 0440 "$signed/signing-report.json" "$work/signed/signing-report.json"
for file in "$signed"/ecf-signed/E*.xml; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'SIGNED_SIMULATION_ECF_INVALID'
  install -o root -g 4101 -m 0440 "$file" "$work/signed/ecf-signed/${file##*/}"
done
for file in "$signed"/rfce-signed/RFCE-E*.xml; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'SIGNED_SIMULATION_RFCE_INVALID'
  install -o root -g 4101 -m 0440 "$file" "$work/signed/rfce-signed/${file##*/}"
done

docker run --rm --network fiscal-network --user 10001:4101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --tmpfs /run/signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  --tmpfs /run/seed-signing-work:rw,noexec,nosuid,size=32m,mode=0700,uid=10001,gid=4101 \
  -v "$config:/run/config/fiscal-signer.json:ro" \
  -v "$runner:/app/fiscal/src/submit-rivnu-simulation-set.ts:ro" \
  -v "$plan:/app/fiscal/src/rivnu-simulation-plan.ts:ro" \
  -v "$xml_runtime:/app/fiscal/src/xml.ts:ro" \
  -v "$work/signed:/signed:ro" \
  -v "$evidence:/evidence" \
  -v "$runtime/certificate.p12:/run/secrets/signing/certificate.p12:ro" \
  -v "$runtime/certificate.password:/run/secrets/signing/password:ro" \
  -v "$runtime/root.crt:/run/trust/digifirma/root.crt:ro" \
  -v "$runtime/subordinate.crt:/run/trust/digifirma/subordinate.crt:ro" \
  -v "$runtime/subordinate.crl.pem:/run/trust/digifirma/subordinate.crl.pem:ro" \
  "$image" node --experimental-strip-types src/submit-rivnu-simulation-set.ts
