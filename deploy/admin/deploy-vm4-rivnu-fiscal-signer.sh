#!/usr/bin/env bash
# Deploy signer with real certificate while signing and delivery controls remain paused.
set -euo pipefail
umask 077
readonly source='/home/luismel/fiscal-signer-deploy'
readonly compose='/opt/corestack/fe/compose/compose.signer.yml'
readonly env='/opt/corestack/fe/compose/signer.env'
readonly config='/opt/corestack/fe/config/fiscal-signer.json'
readonly runtime='/opt/corestack/secrets/rivnu-signer-runtime'
readonly image='corestack/fiscal-signer:pre-20261006'
fail() { printf '%s\n' "$1" >&2; exit 1; }
hash_ok() { [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]]; }
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || fail 'RUN_WITH_SUDO_ON_VM4'
hash_ok "$source/compose.fiscal-signer.yml" 337109535a337d14f2287131da6caab2fa3c3cdd9248ec1288001d280be8d1b6 || fail 'COMPOSE_SOURCE_INVALID'
hash_ok "$source/fiscal-signer.env" 6d9f5108c3d17749bff768c885fad54faf4ff96225f570875d4f490b37975761 || fail 'ENV_SOURCE_INVALID'
hash_ok "$source/fiscal-signer.json" 9419f4b80b2c94238b9ed4b0ab9b3a10bcd5930839ba1f2dde17ba3069e0516d || fail 'CONFIG_SOURCE_INVALID'
[[ -f /opt/corestack/secrets/rivnu-signing/certificate.p12 && -f /opt/corestack/secrets/rivnu-signing/password ]] || fail 'SIGNING_IDENTITY_NOT_PROVISIONED'
[[ -f /opt/corestack/secrets/rivnu-fe-pre-signer-postgresql.password ]] || fail 'SIGNER_DATABASE_SECRET_MISSING'
for trust in root.crt subordinate.crt subordinate.crl.pem; do
  [[ -f "/opt/corestack/fe/config/trust/digifirma/$trust" && ! -L "/opt/corestack/fe/config/trust/digifirma/$trust" ]] || fail 'DIGIFIRMA_TRUST_MISSING'
done
[[ ! -e "$runtime" && ! -L "$runtime" && ! -e "$compose" && ! -e "$env" && ! -e "$config" ]] || fail 'SIGNER_DEPLOYMENT_ALREADY_EXISTS_REVIEW_REQUIRED'
docker image inspect "$image" >/dev/null || fail 'SIGNER_IMAGE_NOT_LOADED'
docker network inspect fiscal-network >/dev/null || fail 'FISCAL_NETWORK_MISSING'

install -d -o root -g 4101 -m 0550 "$runtime"
install -o root -g 4101 -m 0440 /opt/corestack/secrets/rivnu-signing/certificate.p12 "$runtime/certificate.p12"
install -o root -g 4101 -m 0440 /opt/corestack/secrets/rivnu-signing/password "$runtime/certificate.password"
install -o root -g 4101 -m 0440 /opt/corestack/secrets/rivnu-fe-pre-signer-postgresql.password "$runtime/postgresql.password"
for trust in root.crt subordinate.crt subordinate.crl.pem; do
  install -o root -g 4101 -m 0440 "/opt/corestack/fe/config/trust/digifirma/$trust" "$runtime/$trust"
done
install -o root -g 4101 -m 0440 "$source/fiscal-signer.json" "$config"
install -o root -g root -m 0444 "$source/compose.fiscal-signer.yml" "$compose"
install -o root -g root -m 0400 "$source/fiscal-signer.env" "$env"

started=false
cleanup() {
  code=$?
  trap - EXIT
  if (( code != 0 )) && [[ "$started" == true ]]; then
    docker compose --env-file "$env" -f "$compose" down >/dev/null 2>&1 || true
    echo 'SIGNER_DEPLOYMENT_FAILED_CONTAINER_STOPPED_REVIEW_FILES' >&2
  fi
  exit "$code"
}
trap cleanup EXIT
docker compose --env-file "$env" -f "$compose" up -d
started=true
for _ in $(seq 1 40); do
  state=$(docker inspect corestack-fiscal-signer-fiscal-signer-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
  [[ "$state" == healthy ]] && break
  [[ "$state" == unhealthy || "$state" == exited ]] && break
  sleep 2
done
[[ "$state" == healthy ]] || { docker logs --tail 20 corestack-fiscal-signer-fiscal-signer-1 >&2; fail 'SIGNER_NOT_HEALTHY'; }
[[ "$(docker inspect corestack-fiscal-signer-fiscal-signer-1 --format '{{.Config.User}}')" == '10001:4101' ]] || fail 'SIGNER_RUNTIME_IDENTITY_INVALID'
[[ "$(docker port corestack-fiscal-signer-fiscal-signer-1)" == '' ]] || fail 'SIGNER_MUST_NOT_PUBLISH_PORTS'
started=false
echo 'RIVNU_FISCAL_SIGNER_DEPLOYED_HEALTHY_CONTROLS_PAUSED'
echo 'Certificate and database identity verified at startup. No signing request or DGII transmission was enabled.'
