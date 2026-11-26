#!/usr/bin/env bash
set -euo pipefail
# Run only in the uploaded, disposable package directory on VM4.
[[ $(hostname) == CoreStackSystems-VM4-Billing ]] || exit 1
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
[[ "$root" == /home/luismel/fiscal-rehearsal.*/fiscal ]] || exit 1
for name in corestack-disposable-fiscal-db corestack-disposable-fiscal-service; do
 if docker container inspect "$name" >/dev/null 2>&1; then echo 'REHEARSAL_ALREADY_EXISTS'; exit 1; fi
done
if docker network inspect corestack-disposable-fiscal-net >/dev/null 2>&1; then exit 1; fi
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=SYNTHETIC REHEARSAL ONLY' \
 -addext 'subjectAltName=IP:127.0.0.1' -addext 'extendedKeyUsage=serverAuth' \
 -keyout "$root/rehearsal.key" -out "$root/rehearsal.crt" >/dev/null 2>&1
chmod 0400 "$root/rehearsal.key"
chmod 0444 "$root/rehearsal.crt"
docker network create --internal corestack-disposable-fiscal-net >/dev/null
docker run -d --name corestack-disposable-fiscal-db --network corestack-disposable-fiscal-net \
 --cpus .5 --memory 256m --pids-limit 100 --security-opt no-new-privileges:true \
 --tmpfs /var/lib/postgresql/data:rw,size=128m \
 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=corestack_disposable_rehearsal \
 -v "$root/test/distributed-bootstrap.sql:/docker-entrypoint-initdb.d/fixture.sql:ro" \
 -v "$root/sql/001_sequence_registry.sql:/fixture/001.sql:ro" \
 -v "$root/sql/002_request_persistence.sql:/fixture/002.sql:ro" \
 -v "$root/sql/003_preparation_worker.sql:/fixture/003.sql:ro" postgres:17-alpine >/dev/null
ready=false
for ((i=0;i<60;i++)); do
 if docker exec corestack-disposable-fiscal-db psql -U postgres -d corestack_disposable_rehearsal -Atc \
  "SELECT count(*) FROM corestack_fiscal.runtime_scope" 2>/dev/null | grep -qx 1; then ready=true; break; fi
 sleep 1
done
[[ "$ready" == true ]] || { echo REHEARSAL_DB_NOT_READY; exit 1; }
docker run -d --name corestack-disposable-fiscal-service --network corestack-disposable-fiscal-net \
 --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,size=64m \
 --cpus .5 --memory 256m --pids-limit 100 --cap-drop ALL --security-opt no-new-privileges:true \
 --no-healthcheck -e FISCAL_DISPOSABLE_REHEARSAL=YES_NO_REAL_DATA \
 -v "$root/src:/app/fiscal/src:ro" -v "$root/test:/app/fiscal/test:ro" \
 -v "$root/rehearsal.crt:/run/rehearsal.crt:ro" -v "$root/rehearsal.key:/run/rehearsal.key:ro" \
 --entrypoint node corestack/fiscal-registration:dev-20260922 test/distributed-server.ts >/dev/null
ready=false
for ((i=0;i<30;i++)); do
 if docker logs corestack-disposable-fiscal-service 2>&1 | grep -q SYNTHETIC_DISTRIBUTED_READY; then ready=true; break; fi
 if [[ $(docker inspect -f '{{.State.Running}}' corestack-disposable-fiscal-service) != true ]]; then break; fi
 sleep 1
done
[[ "$ready" == true ]] || { echo REHEARSAL_SERVICE_NOT_READY; exit 1; }
echo 'REHEARSAL_STARTED_INTERNAL_NETWORK_NO_VM3_NO_DGII'
docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' corestack-disposable-fiscal-service
