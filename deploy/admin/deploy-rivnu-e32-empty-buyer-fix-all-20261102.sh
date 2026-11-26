#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

readonly repo='/opt/corestack/apps/rivnu/repo/CoreStackSystemsv1'
readonly image='/home/luismel/corestack-fiscal-production-rivnu-e32-empty-buyer-fix-20261102.tar.gz'
readonly image_sha='328742eaabb472daa1899c6644d1381a39a770427a7556d06397fa79aa12313f'
readonly vm3='luismel@10.0.0.4'
readonly vm4='luismel@10.0.0.1'
readonly control="/tmp/rivnu-e32-fix-$$"
readonly activation='/home/luismel/activate-vm4-rivnu-e32-empty-buyer-fix-20261102.sh'
readonly retry='/home/luismel/retry-vm3-rivnu-e32-0000000001-20261102.sh'
fail(){ printf '%s\n' "$1" >&2; exit 1; }
cleanup(){
  ssh -S "$control/vm3" -O exit "$vm3" >/dev/null 2>&1 || true
  ssh -S "$control/vm4" -O exit "$vm4" >/dev/null 2>&1 || true
  rmdir "$control" 2>/dev/null || true
}
trap cleanup EXIT

[[ "$(hostname)" == 'VM2-APP' && "$PWD" == "$repo" ]] || fail RUN_FROM_RIVNU_REPOSITORY_ON_VM2
[[ -f "$image" && ! -L "$image" ]] || fail IMAGE_ARCHIVE_MISSING
[[ "$(sha256sum "$image" | cut -d' ' -f1)" == "$image_sha" ]] || fail IMAGE_ARCHIVE_HASH_MISMATCH
mkdir -m 0700 "$control"

printf '%s\n' 'Conectando VM4 para activar la corrección de firma E32...'
ssh -MNf -o ControlMaster=yes -o ControlPersist=15m -o ControlPath="$control/vm4" "$vm4"
scp -o ControlPath="$control/vm4" \
  "$image" \
  "$repo/deploy/admin/activate-vm4-rivnu-e32-empty-buyer-fix-20261102.sh" \
  "$vm4:/home/luismel/"
ssh -tt -o ControlPath="$control/vm4" "$vm4" "set -e; test \"\$(sha256sum '$image' | cut -d' ' -f1)\" = '$image_sha'; gzip -dc '$image' | sudo docker load; chmod 700 '$activation'; sudo '$activation'"

printf '%s\n' 'Conectando VM3 para reintentar el mismo E320000000001...'
ssh -MNf -o ControlMaster=yes -o ControlPersist=15m -o ControlPath="$control/vm3" "$vm3"
scp -o ControlPath="$control/vm3" \
  "$repo/deploy/admin/retry-vm3-rivnu-e32-0000000001-20261102.sh" \
  "$vm3:/home/luismel/"
ssh -tt -o ControlPath="$control/vm3" "$vm3" "set -e; chmod 700 '$retry'; sudo '$retry'"

printf '%s\n' 'Esperando aceptación fiscal y representación impresa...'
for _ in $(seq 1 90); do
  status=$(docker exec -i rivnu-api node - <<'NODE'
const {PrismaClient}=require('/app/packages/database/dist');
const p=new PrismaClient();
(async()=>{const x=await p.invoice.findUnique({where:{id:'cmvzvt4bs000joh075va5rkbg'},select:{fiscalStatus:true,status:true}});process.stdout.write(x?`${x.fiscalStatus}|${x.status}`:'MISSING');await p.$disconnect()})().catch(async()=>{await p.$disconnect();process.exit(1)});
NODE
  )
  [[ "$status" == 'ACCEPTED|ACCEPTED' ]] && break
  sleep 1
done
[[ "$status" == 'ACCEPTED|ACCEPTED' ]] || fail "E32_ACCEPTANCE_TIMEOUT_$status"

docker exec -i rivnu-api node - <<'NODE'
const {createElectronicRangeRegistrationClientFromEnvironment}=require('/app/apps/api/dist/modules/fiscal-sequences/electronic-range-registration.client.js');
const c=createElectronicRangeRegistrationClientFromEnvironment();
(async()=>{const model=await c.readPrintedRepresentation('cmqn0r66a0002lit0vxbzq5l4','1');if(model.encf!=='E320000000001'||model.total!=='4.99'||!model.qrUrl.startsWith('https://'))process.exit(1);console.log('RIVNU_E32_PRINTED_REPRESENTATION_READY encf=E320000000001 total=4.99 qr=READY')})().catch(()=>process.exit(1));
NODE

printf '%s\n' 'RIVNU_E32_EMPTY_BUYER_FIX_DEPLOYED_AND_EXISTING_SALE_ACCEPTED'
printf '%s\n' 'Refresh the existing invoice page once; its official QR representation is ready to print.'
