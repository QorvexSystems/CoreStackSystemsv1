#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
printf '%s\n' 'RETIRED: certification is an internal CoreStack CLI, not a RIVNU module.' >&2
exit 1
readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly name='20261104170000_electronic_certification_orchestrator'
[[ "$(hostname)" == VM2-APP && "$PWD" == "$repo" ]] || { echo RUN_FROM_REPOSITORY_ON_VM2 >&2; exit 1; }
readonly work="$(mktemp -d /home/luismel/certification-agent-deploy.XXXXXX)"
tar -czf "$work/migration.tar.gz" deploy/admin/migrate-vm3-certification-agent-20261104.sh \
  "packages/database/prisma/migrations/$name/migration.sql"
readonly hash="$(sha256sum "$work/migration.tar.gz" | cut -d' ' -f1)"
readonly remote='/home/luismel/certification-agent-deploy-20261104'
scp "$work/migration.tar.gz" luismel@10.0.0.4:/home/luismel/certification-agent-migration-20261104.tar.gz
ssh -tt luismel@10.0.0.4 "set -Eeuo pipefail
  test \"\$(sha256sum /home/luismel/certification-agent-migration-20261104.tar.gz | cut -d' ' -f1)\" = '$hash'
  if test ! -d '$remote'; then mkdir -m 700 '$remote'; fi
  tar -xzf /home/luismel/certification-agent-migration-20261104.tar.gz -C '$remote'
  sudo bash '$remote/deploy/admin/migrate-vm3-certification-agent-20261104.sh'"
sudo bash deploy/admin/activate-vm2-certification-agent-20261104.sh
printf '%s\n' CERTIFICATION_AGENT_VM3_VM2_DEPLOYED_NO_CLIENT_STARTED
printf '%s\n' 'VM4 execution remains disabled until a client-specific reviewed runner is provisioned.'
