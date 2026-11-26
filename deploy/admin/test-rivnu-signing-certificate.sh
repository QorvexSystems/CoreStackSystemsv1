#!/usr/bin/env bash
set -euo pipefail

readonly image='corestack/fiscal-pkcs12-self-test:20261006'
readonly secret='/opt/corestack/secrets/rivnu-signing'
readonly trust='/opt/corestack/fe/config/trust/digifirma'

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'RUN_WITH_SUDO'
command -v docker >/dev/null || fail 'DOCKER_NOT_AVAILABLE'
docker image inspect "$image" >/dev/null 2>&1 || fail 'SELF_TEST_IMAGE_NOT_INSTALLED'
[[ "$(stat -c '%U:%G:%a' "$secret")" == 'root:root:700' ]] || fail 'SIGNING_SECRET_DIRECTORY_INVALID'
for file in certificate.p12 password; do
  [[ -f "$secret/$file" && ! -L "$secret/$file" ]] || fail 'SIGNING_SECRET_FILE_INVALID'
  [[ "$(stat -c '%U:%G:%a' "$secret/$file")" == 'root:root:400' ]] || fail 'SIGNING_SECRET_PERMISSIONS_INVALID'
done
for file in root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "$trust/$file" && ! -L "$trust/$file" ]] || fail 'SIGNING_TRUST_FILE_INVALID'
done

docker run --rm --read-only --network none --user 0:0 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 256m --cpus 1 \
  --tmpfs /work:rw,noexec,nosuid,nodev,size=32m \
  --mount "type=bind,src=$secret/certificate.p12,dst=/run/secrets/rivnu/certificate.p12,readonly" \
  --mount "type=bind,src=$secret/password,dst=/run/secrets/rivnu/password,readonly" \
  --mount "type=bind,src=$trust/root.crt,dst=/run/trust/digifirma/root.crt,readonly" \
  --mount "type=bind,src=$trust/subordinate.crt,dst=/run/trust/digifirma/subordinate.crt,readonly" \
  --mount "type=bind,src=$trust/subordinate.crl.pem,dst=/run/trust/digifirma/subordinate.crl.pem,readonly" \
  "$image"

echo 'No DGII request, queue, database or production configuration was used.'
