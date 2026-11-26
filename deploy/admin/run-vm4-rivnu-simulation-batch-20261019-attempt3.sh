#!/usr/bin/env bash
# Advance RIVNU simulation attempt 3 only while every observation is acceptable.
set -euo pipefail
umask 077
readonly step='/home/luismel/run-vm4-rivnu-simulation-step-20261019-attempt3.sh'
readonly maximum_steps=200
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
[[ -x "$step" && ! -L "$step" ]] || fail 'SIMULATION_STEP_RUNNER_INVALID'
for ((iteration = 1; iteration <= maximum_steps; iteration++)); do
  if ! output=$("$step" 2>&1); then printf '%s\n' "$output"; fail 'RIVNU_SIMULATION_BATCH_STOPPED_STEP_FAILED'; fi
  printf '%s\n' "$output"
  if grep -q '^RIVNU_SIMULATION_API_SET_ACCEPTED_PORTAL_E32_UPLOAD_READY$' <<<"$output"; then
    printf '%s\n' 'RIVNU_SIMULATION_ATTEMPT3_BATCH_API_PHASES_COMPLETE'; exit 0
  fi
  if grep -qE '^RIVNU_SIMULATION_STEP_RECORDED route=RFCE encf=E[0-9]{12} state=ACCEPTED$' <<<"$output"; then sleep 20; continue; fi
  if grep -qE '^RIVNU_SIMULATION_STEP_RECORDED route=ECF encf=E[0-9]{12} state=ACCEPTED$' <<<"$output"; then sleep 3; continue; fi
  if grep -qE '^RIVNU_SIMULATION_STEP_RECORDED route=(ECF|RFCE) encf=E[0-9]{12} state=PROCESSING$' <<<"$output"; then sleep 10; continue; fi
  fail 'RIVNU_SIMULATION_BATCH_STOPPED_NON_ACCEPTED_STATE'
done
fail 'RIVNU_SIMULATION_BATCH_STOPPED_STEP_LIMIT'
