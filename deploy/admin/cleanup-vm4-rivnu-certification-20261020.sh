#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly home_root=/home/luismel
readonly archive=/opt/corestack/backups/rivnu-certification-complete-20261020
readonly receiver=corestack-fiscal-receiver-fiscal-receiver-1
readonly expected_receiver_image=sha256:9d872e74f6be954cfd1cc1ddad2983a017c426a9723e0b7a16562865e446aed7

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail RUN_WITH_SUDO_ON_VM4
[[ ! -e "$archive" && ! -L "$archive" ]] || fail CLEANUP_ARCHIVE_ALREADY_EXISTS
[[ "$(docker inspect "$receiver" --format '{{.Image}}')" == "$expected_receiver_image" ]] ||
  fail ACTIVE_RECEIVER_IMAGE_UNEXPECTED
[[ "$(docker inspect "$receiver" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" == healthy ]] ||
  fail ACTIVE_RECEIVER_NOT_HEALTHY

mounted_home="$({
  for container in $(docker ps -aq); do
    docker inspect "$container" --format '{{range .Mounts}}{{println .Source}}{{end}}'
  done
} | grep '^/home/luismel/' || true)"
[[ -z "$mounted_home" ]] || fail CONTAINER_DEPENDS_ON_HOME_ARTIFACTS

readonly final_names=(
  rivnu-postulacion-externa
  rivnu-certification-set-input-20261019
  rivnu-certification-set-signed-20261019-attempt2
  rivnu-certification-evidence-20261019-attempt2
  rivnu-commercial-approval-input-20261019
  rivnu-commercial-approval-signed-20261019
  rivnu-commercial-approval-evidence-20261019
  rivnu-simulation-input-20261019-attempt3
  rivnu-simulation-signed-20261019-attempt3
  rivnu-simulation-evidence-20261019-attempt3
  rivnu-sworn-declaration-20261020
)
for name in "${final_names[@]}"; do
  [[ -d "$home_root/$name" && ! -L "$home_root/$name" ]] || fail "FINAL_ARTIFACT_MISSING_$name"
done

install -d -o root -g root -m 0700 "$archive" "$archive/final" "$archive/receiver-evidence"
for name in "${final_names[@]}"; do
  mv -- "$home_root/$name" "$archive/final/"
done
cp -a -- /opt/corestack/fe/evidence/receiver/. "$archive/receiver-evidence/"

# Preserve small failed-attempt and operator artifacts in one audit archive.
# Exported Docker images are excluded because identical copies are retained on VM2.
mapfile -d '' residual < <(
  find "$home_root" -maxdepth 1 -mindepth 1 \
    \( -iname '*rivnu*' -o -iname '*fiscal*' -o -name '*20261006*' -o -name '*20261012*' -o -name '*20261019*' -o -name '*20261020*' \) \
    ! -name '*.tar.gz' -print0
)
if (( ${#residual[@]} > 0 )); then
  relative=()
  for path in "${residual[@]}"; do
    [[ "$path" == "$home_root/"* && ! -L "$path" ]] || fail RESIDUAL_PATH_INVALID
    relative+=("${path#"$home_root/"}")
  done
  tar -C "$home_root" -czf "$archive/failed-attempts-and-operator-material.tar.gz" -- "${relative[@]}"
  gzip -t "$archive/failed-attempts-and-operator-material.tar.gz"
  for path in "${residual[@]}"; do rm -rf -- "$path"; done
fi

# These are transport copies already retained in the VM2 certification archive.
mapfile -d '' exports < <(
  find "$home_root" -maxdepth 1 -type f -name '*.tar.gz' \
    \( -iname '*rivnu*' -o -iname '*fiscal*' -o -name '*20261006*' -o -name '*20261012*' -o -name '*20261019*' -o -name '*20261020*' \) \
    -print0
)
for path in "${exports[@]}"; do
  [[ "$path" == "$home_root/"* && ! -L "$path" ]] || fail EXPORT_PATH_INVALID
  rm -f -- "$path"
done

(
  cd "$archive"
  find final receiver-evidence -type f -print0 | sort -z | xargs -0 sha256sum
  [[ ! -f failed-attempts-and-operator-material.tar.gz ]] || sha256sum failed-attempts-and-operator-material.tar.gz
) > "$archive/SHA256SUMS"
chmod 0600 "$archive/SHA256SUMS"

readonly old_images=(
  corestack/fiscal-signer:sworn-declaration-rivnu-20261020
  corestack/fiscal-signer:external-postulation-91092-20261012
  corestack/fiscal-signer:cert-route-20261006
  corestack/fiscal-signer:postulation-whitespace-fix
  corestack/fiscal-signer:pre-20261006
  corestack/fiscal-pkcs12-self-test:20261006
)
for image in "${old_images[@]}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >/dev/null; fi
done
docker builder prune --force >/dev/null

[[ "$(docker inspect "$receiver" --format '{{.Image}}')" == "$expected_receiver_image" ]] ||
  fail ACTIVE_RECEIVER_CHANGED
[[ "$(docker inspect "$receiver" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" == healthy ]] ||
  fail ACTIVE_RECEIVER_UNHEALTHY_AFTER_CLEANUP
[[ "$(docker ps --filter status=running --format '{{.Names}}' | wc -l)" -eq 7 ]] || fail ACTIVE_CONTAINER_COUNT_CHANGED

remaining="$(find "$home_root" -maxdepth 1 -mindepth 1 \
  \( -iname '*rivnu*' -o -iname '*fiscal*' -o -name '*20261019*' -o -name '*20261020*' \) -print)"
[[ -z "$remaining" ]] || fail HOME_CERTIFICATION_ARTIFACTS_REMAIN

printf 'RIVNU_VM4_CERTIFICATION_CLEANUP_COMPLETE archive=%s\n' "$archive"
du -sh "$archive"
docker system df
df -h /
