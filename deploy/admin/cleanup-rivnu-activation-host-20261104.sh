#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly operator_home='/home/luismel'
readonly host="$(hostname)"
readonly started_at="$(date -u +%Y%m%dT%H%M%SZ)"
readonly audit_root="/opt/corestack/backups/rivnu-activation-cleanup-${started_at}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail RUN_WITH_SUDO
case "$host" in
  VM2-APP|VM3-SQLDB|CoreStackSystems-VM4-Billing|CoreStack-VM1-Gateway) ;;
  *) fail "UNEXPECTED_HOST_${host}" ;;
esac
[[ -d "$operator_home" && ! -L "$operator_home" ]] || fail OPERATOR_HOME_INVALID

install -d -o root -g root -m 0700 "$audit_root"
{
  printf 'host=%s\n' "$host"
  printf 'started_at_utc=%s\n' "$started_at"
  df -B1 /
} >"$audit_root/before.txt"

docker_available=false
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_available=true
  {
    for container in $(docker ps -q); do
      docker inspect "$container" --format '{{.Name}}|{{.Image}}'
    done
  } | sort >"$audit_root/active-containers.before"

  mounted_home="$({
    for container in $(docker ps -aq); do
      docker inspect "$container" --format '{{range .Mounts}}{{println .Source}}{{end}}'
    done
  } | grep '^/home/luismel/' || true)"
  [[ -z "$mounted_home" ]] || {
    printf '%s\n' "$mounted_home" >"$audit_root/home-container-mounts.txt"
    fail CONTAINER_DEPENDS_ON_HOME_ARTIFACT
  }

  docker system df >"$audit_root/docker-before.txt"
  docker builder prune --all --force >"$audit_root/docker-builder-prune.txt"
  docker image prune --all --force >"$audit_root/docker-image-prune.txt"
fi

# Only transport copies and one-off activation material in the operator's home
# are eligible. Source-controlled deploy scripts, live /opt configuration,
# secrets, databases, fiscal evidence and rollback backups are outside scope.
mapfile -d '' candidates < <(
  find "$operator_home" -maxdepth 1 -mindepth 1 \
    \( \
      -name '*20261019*' -o \
      -name '*20261020*' -o \
      -name '*20261031*' -o \
      -name '*20261101*' -o \
      -name '*20261102*' \
    \) \
    ! -name 'corestack-rivnu-admin' \
    ! -name 'certification-archives' \
    ! -type l \
    -print0
)

printf 'kind\tbytes\tsha256\tpath\n' >"$audit_root/removed-home-artifacts.tsv"
for path in "${candidates[@]}"; do
  [[ "$path" == "$operator_home/"* && "$path" != "$operator_home" && ! -L "$path" ]] ||
    fail HOME_CANDIDATE_INVALID
  if [[ -f "$path" ]]; then
    printf 'file\t%s\t%s\t%s\n' \
      "$(stat -c '%s' "$path")" \
      "$(sha256sum "$path" | awk '{print $1}')" \
      "$path" >>"$audit_root/removed-home-artifacts.tsv"
    rm -f -- "$path"
  elif [[ -d "$path" ]]; then
    printf 'directory\t%s\t-\t%s\n' \
      "$(du -sb "$path" | awk '{print $1}')" \
      "$path" >>"$audit_root/removed-home-artifacts.tsv"
    rm -rf -- "$path"
  fi
done

# User cache is reproducible and contains no application state. Keep the cache
# directory itself so ownership and desktop tooling remain predictable.
if [[ -d "$operator_home/.cache" && ! -L "$operator_home/.cache" ]]; then
  cache_bytes="$(du -sb "$operator_home/.cache" | awk '{print $1}')"
  printf 'cache\t%s\t-\t%s\n' "$cache_bytes" "$operator_home/.cache/*" \
    >>"$audit_root/removed-home-artifacts.tsv"
  find "$operator_home/.cache" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  chown luismel:luismel "$operator_home/.cache"
  chmod 0700 "$operator_home/.cache"
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get clean
fi

if [[ "$docker_available" == true ]]; then
  {
    for container in $(docker ps -q); do
      docker inspect "$container" --format '{{.Name}}|{{.Image}}'
    done
  } | sort >"$audit_root/active-containers.after"
  cmp -s "$audit_root/active-containers.before" "$audit_root/active-containers.after" ||
    fail ACTIVE_CONTAINER_SET_CHANGED
  docker system df >"$audit_root/docker-after.txt"
fi

{
  printf 'completed_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  df -B1 /
} >"$audit_root/after.txt"

chmod 0600 "$audit_root"/*
printf 'RIVNU_ACTIVATION_CLEANUP_COMPLETE host=%s audit=%s\n' "$host" "$audit_root"
df -h /
if [[ "$docker_available" == true ]]; then docker system df; fi

