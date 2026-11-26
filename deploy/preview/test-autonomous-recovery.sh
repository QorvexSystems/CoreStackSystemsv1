#!/usr/bin/env bash
# Fault injection ONLY in the named synthetic VM4 service. Production untouched.
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
preview_vm4() {
 ssh -i /home/luismel/.ssh/corestack_codex_vm4_20260920 \
  -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 \
  luismel@10.0.0.1 "$@"
}
project=$(preview_vm4 'docker inspect -f '\''{{index .Config.Labels "com.docker.compose.project"}}'\'' corestack-preview-remote-service')
[[ "$project" == corestack-preview-remote ]] || { echo 'PREVIEW_CONTAINER_IDENTITY_MISMATCH' >&2; exit 1; }
umask 077
recovery_logs=$(mktemp -d /tmp/corestack-recovery-test.XXXXXX)
stopped=false
restore_preview() {
 if [[ "$stopped" == true ]]; then
  preview_vm4 'docker start corestack-preview-remote-service' >/dev/null || {
   echo 'URGENT: restart corestack-preview-remote-service on VM4 manually.' >&2; return 1;
  }
 fi
}
trap restore_preview EXIT
stopped=true
preview_vm4 'docker stop --time 5 corestack-preview-remote-service' >/dev/null
docker run --rm --network host --entrypoint node \
 -e EXPECT_REMOTE=true -e EXPECT_AUTONOMOUS=true \
 -v "$repo/deploy/preview/test-order-flow.cjs:/test-order-flow.cjs:ro" \
 corestack/rivnu-api:ecf-recovery-20260923 /test-order-flow.cjs > "$recovery_logs/result.log" 2>&1 &
recovery_pid=$!
observed=false
for ((i=0;i<80;i++)); do
 if rg -q AUTONOMOUS_RECOVERY_PENDING "$recovery_logs/result.log"; then observed=true; break; fi
 if ! kill -0 "$recovery_pid" 2>/dev/null; then break; fi
 sleep 0.25
done
restore_preview
stopped=false
if ! wait "$recovery_pid"; then
 sed -n '1,100p' "$recovery_logs/result.log"
 echo "Test diagnostics retained: $recovery_logs" >&2
 exit 1
fi
if [[ "$observed" != true ]] && rg -q AUTONOMOUS_RECOVERY_PENDING "$recovery_logs/result.log"; then observed=true; fi
[[ "$observed" == true ]] || { echo 'PENDING_STATE_NOT_OBSERVED' >&2; exit 1; }
sed -n '1,100p' "$recovery_logs/result.log"
echo "Test diagnostics retained: $recovery_logs"
