#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly compose=/opt/corestack/fe/compose/compose.fiscal-receiver.yml
readonly env_file=/opt/corestack/fe/compose/fiscal-receiver.env
readonly service=corestack-fiscal-receiver-fiscal-receiver-1
readonly image=corestack/fiscal-receiver:certification-20261020
readonly expected_image_id=sha256:0dad29ff440c9cf442cb1fdfbaca19e3ed179b173492c92cc993a551b719e4d6
fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
[[ -f "$compose" && -f "$env_file" ]] || fail RECEIVER_DEPLOYMENT_MISSING
readonly loaded_image_id="$(docker image inspect "$image" --format '{{.Id}}')"
[[ "$loaded_image_id" == "$expected_image_id" ]] || fail DIAGNOSTIC_IMAGE_ID_MISMATCH
readonly previous_image_id="$(docker inspect "$service" --format '{{.Image}}')"
[[ "$previous_image_id" != "$loaded_image_id" ]] || fail DIAGNOSTIC_IMAGE_ALREADY_RUNNING

rollback() {
  code=$?
  trap - ERR
  docker tag "$previous_image_id" "$image"
  docker compose --env-file "$env_file" -f "$compose" up -d --force-recreate >/dev/null 2>&1 || true
  printf 'RIVNU_FISCAL_RECEIVER_DIAGNOSTIC_UPDATE_ROLLED_BACK\n' >&2
  exit "$code"
}
trap rollback ERR

docker compose --env-file "$env_file" -f "$compose" up -d --force-recreate
for _ in $(seq 1 40); do
  state="$(docker inspect "$service" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy || "$state" == exited ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || { docker logs --tail 30 "$service" >&2; fail RECEIVER_NOT_HEALTHY; }
[[ "$(docker inspect "$service" --format '{{.Image}}')" == "$loaded_image_id" ]] || fail RECEIVER_IMAGE_NOT_UPDATED
trap - ERR
printf 'RIVNU_FISCAL_RECEIVER_DIAGNOSTICS_ACTIVE image=%s previous=%s\n' "$loaded_image_id" "$previous_image_id"
