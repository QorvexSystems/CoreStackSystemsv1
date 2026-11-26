#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly bundle='/home/luismel/rivnu-printed-representation-deploy-20261102.tar.gz'
readonly images='/home/luismel/rivnu-printed-representation-vm4-images-20261102.tar.gz'
readonly deployment_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly remote_dir="/home/luismel/rivnu-printed-representation-deploy-$deployment_id"
readonly vm3='luismel@10.0.0.4'
readonly vm4='luismel@10.0.0.1'
readonly control_root="/tmp/rivnu-ri-deploy-$$"
fail(){ printf '%s\n' "$1" >&2; exit 1; }
cleanup(){
  ssh -S "$control_root/vm3" -O exit "$vm3" >/dev/null 2>&1 || true
  ssh -S "$control_root/vm4" -O exit "$vm4" >/dev/null 2>&1 || true
  rmdir "$control_root" 2>/dev/null || true
}
trap cleanup EXIT

[[ "$(hostname)" == 'VM2-APP' && "$PWD" == "$repo" ]] || fail RUN_FROM_RIVNU_REPOSITORY_ON_VM2
[[ -f "$bundle" && -f "$images" ]] || fail DEPLOYMENT_ARTIFACTS_MISSING
readonly bundle_sha256='c7685f664aeef34e694811369ebdb05ac37431b5fd56a0ec133f1546c06fd0dd'
readonly images_sha256='ed7791b436c912496c279fb84cb71bda71e7d9e6dbafb70a20357d3c151dc251'
[[ "$(sha256sum "$bundle" | cut -d' ' -f1)" == "$bundle_sha256" ]] || fail DEPLOYMENT_BUNDLE_HASH_MISMATCH
[[ "$(sha256sum "$images" | cut -d' ' -f1)" == "$images_sha256" ]] || fail VM4_IMAGES_HASH_MISMATCH
mkdir -m 0700 "$control_root"

printf '%s\n' 'Conectando VM3 (una sola autenticación SSH)...'
ssh -MNf -o ControlMaster=yes -o ControlPersist=15m -o ControlPath="$control_root/vm3" "$vm3"
printf '%s\n' 'Conectando VM4 (una sola autenticación SSH)...'
ssh -MNf -o ControlMaster=yes -o ControlPersist=15m -o ControlPath="$control_root/vm4" "$vm4"

scp -o ControlPath="$control_root/vm3" "$bundle" "$vm3:/home/luismel/"
ssh -tt -o ControlPath="$control_root/vm3" "$vm3" "set -e; test \"\$(sha256sum '$bundle' | cut -d' ' -f1)\" = '$bundle_sha256'; test ! -e '$remote_dir'; mkdir -m 700 '$remote_dir'; tar -xzf '$bundle' -C '$remote_dir'; chmod 700 '$remote_dir/deploy/admin/migrate-vm3-rivnu-printed-representation-20261102.sh'; sudo '$remote_dir/deploy/admin/migrate-vm3-rivnu-printed-representation-20261102.sh'"

scp -o ControlPath="$control_root/vm4" "$bundle" "$images" "$vm4:/home/luismel/"
ssh -tt -o ControlPath="$control_root/vm4" "$vm4" "set -e; test \"\$(sha256sum '$bundle' | cut -d' ' -f1)\" = '$bundle_sha256'; test \"\$(sha256sum '$images' | cut -d' ' -f1)\" = '$images_sha256'; test ! -e '$remote_dir'; mkdir -m 700 '$remote_dir'; tar -xzf '$bundle' -C '$remote_dir'; gzip -dc '$images' | sudo docker load; chmod 700 '$remote_dir/deploy/admin/activate-vm4-rivnu-printed-representation-20261102.sh'; sudo '$remote_dir/deploy/admin/activate-vm4-rivnu-printed-representation-20261102.sh'"

chmod 700 "$repo/deploy/admin/activate-vm2-rivnu-printed-representation-20261102.sh"
sudo "$repo/deploy/admin/activate-vm2-rivnu-printed-representation-20261102.sh"

printf '%s\n' 'RIVNU_PRINTED_REPRESENTATION_ALL_HOSTS_DEPLOYED'
printf '%s\n' 'No test invoice, e-NCF reservation or DGII fiscal submission was created.'
