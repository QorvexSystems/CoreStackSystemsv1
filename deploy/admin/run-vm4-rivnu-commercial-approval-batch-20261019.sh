#!/usr/bin/env bash
# Advance the signed commercial-approval set while every response is accepted.
set -euo pipefail
umask 077

readonly step='/home/luismel/run-vm4-rivnu-commercial-approval-step-20261019.sh'
readonly maximum_steps=12
readonly accepted_wait_seconds=3

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -x "$step" && ! -L "$step" ]] || fail 'COMMERCIAL_APPROVAL_STEP_RUNNER_INVALID'

for ((iteration = 1; iteration <= maximum_steps; iteration++)); do
  if ! output=$("$step" 2>&1); then
    printf '%s\n' "$output"
    fail 'RIVNU_COMMERCIAL_APPROVAL_BATCH_STOPPED_STEP_FAILED'
  fi
  printf '%s\n' "$output"

  if grep -q '^RIVNU_COMMERCIAL_APPROVAL_SET_ACCEPTED_COUNT=11$' <<<"$output"; then
    printf '%s\n' 'RIVNU_COMMERCIAL_APPROVAL_BATCH_COMPLETE'
    exit 0
  fi
  if grep -qE '^RIVNU_COMMERCIAL_APPROVAL_STEP_RECORDED encf=E[0-9]{12} state=ACCEPTED code=(1|01)$' <<<"$output"; then
    sleep "$accepted_wait_seconds"
    continue
  fi

  fail 'RIVNU_COMMERCIAL_APPROVAL_BATCH_STOPPED_NON_ACCEPTED_STATE'
done

fail 'RIVNU_COMMERCIAL_APPROVAL_BATCH_STOPPED_STEP_LIMIT'
