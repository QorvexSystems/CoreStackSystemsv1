#!/usr/bin/env bash
# Advance RIVNU's second certification attempt while all results are accepted.
set -euo pipefail
umask 077

readonly step='/home/luismel/run-vm4-rivnu-certification-step-20261019-attempt2.sh'
readonly maximum_steps=200
readonly processing_wait_seconds=10
readonly accepted_wait_seconds=2
readonly rfce_accepted_wait_seconds=20

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -x "$step" && ! -L "$step" ]] || fail 'CERTIFICATION_STEP_RUNNER_INVALID'

for ((iteration = 1; iteration <= maximum_steps; iteration++)); do
  if ! output=$("$step" 2>&1); then
    printf '%s\n' "$output"
    fail 'RIVNU_CERTIFICATION_BATCH_STOPPED_STEP_FAILED'
  fi
  printf '%s\n' "$output"

  if grep -q '^RIVNU_CERTIFICATION_API_SET_ACCEPTED_PORTAL_E32_UPLOAD_READY$' <<<"$output"; then
    printf '%s\n' 'RIVNU_CERTIFICATION_BATCH_API_PHASES_COMPLETE'
    exit 0
  fi
  if grep -qE '^RIVNU_CERTIFICATION_STEP_RECORDED route=RFCE encf=E[0-9]{12} state=ACCEPTED$' <<<"$output"; then
    sleep "$rfce_accepted_wait_seconds"
    continue
  fi
  if grep -qE '^RIVNU_CERTIFICATION_STEP_RECORDED route=ECF encf=E[0-9]{12} state=ACCEPTED$' <<<"$output"; then
    sleep "$accepted_wait_seconds"
    continue
  fi
  if grep -qE '^RIVNU_CERTIFICATION_STEP_RECORDED route=(ECF|RFCE) encf=E[0-9]{12} state=PROCESSING$' <<<"$output"; then
    sleep "$processing_wait_seconds"
    continue
  fi

  fail 'RIVNU_CERTIFICATION_BATCH_STOPPED_NON_ACCEPTED_STATE'
done

fail 'RIVNU_CERTIFICATION_BATCH_STOPPED_STEP_LIMIT'
