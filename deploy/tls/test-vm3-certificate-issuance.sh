#!/usr/bin/env bash
# ONLY in a disposable container: mounts below are mandatory and test CA is fake.
# Example: docker run --rm -it --user 0 --network none --hostname VM3-SQLDB \
# --tmpfs /var/lib/corestack-pki:mode=0700 \
# --tmpfs /usr/local/share/corestack-pki:mode=0755 --tmpfs /tmp \
# -v "$PWD/deploy:/work:ro" --entrypoint bash corestack/rivnu-api:a388b1aeba4a \
# /work/tls/test-vm3-certificate-issuance.sh
set -euo pipefail
umask 077
[[ -f /.dockerenv ]] || exit 1
for directory in /var/lib/corestack-pki /usr/local/share/corestack-pki /tmp; do
  [[ "$(stat -f -c '%T' "$directory")" == tmpfs ]] || exit 1
done
ca=/var/lib/corestack-pki/internal-root-2026
mkdir -m 0700 "$ca" "$ca/private"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -aes-256-cbc \
  -pass pass:synthetic-test-only -out "$ca/private/ca.key.pem" 2>/dev/null
chmod 0400 "$ca/private/ca.key.pem"
openssl req -new -x509 -sha256 -days 730 -key "$ca/private/ca.key.pem" \
  -passin pass:synthetic-test-only -subj '/CN=Disposable TEST CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$ca/ca.crt.pem"
chmod 0444 "$ca/ca.crt.pem"
install -m 0444 "$ca/ca.crt.pem" /usr/local/share/corestack-pki/internal-root-2026.crt
if bash /work/admin/issue-vm3-postgresql-certificate.sh; then
  echo 'FAIL: wrong CA fingerprint accepted'; exit 1
fi
[[ ! -e /var/lib/corestack-pki/issued ]] || exit 1
fingerprint=$(openssl x509 -in "$ca/ca.crt.pem" -noout -fingerprint -sha256)
# Only the disposable copy gets the synthetic CA pin; production script unchanged.
sed "s/^readonly expected_ca=.*/readonly expected_ca='${fingerprint#*=}'/" \
  /work/admin/issue-vm3-postgresql-certificate.sh > /tmp/issue-test.sh
printf '\nTEST ONLY: enter synthetic-test-only at the next prompt.\n'
bash /tmp/issue-test.sh
bundle=/var/lib/corestack-pki/issued/vm3-postgresql-2026
[[ "$(stat -c '%u:%g:%a' "$bundle/server.key.pem")" == 0:0:400 ]]
[[ "$(stat -c '%u:%g:%a' "$bundle")" == 0:0:700 ]]
openssl verify -CAfile "$ca/ca.crt.pem" -verify_ip 10.0.0.4 "$bundle/server.crt.pem"
if openssl verify -CAfile "$ca/ca.crt.pem" -verify_ip 10.0.0.99 "$bundle/server.crt.pem"; then
  echo 'FAIL: incorrect IP accepted'; exit 1
fi
before=$(sha256sum "$bundle/server.key.pem" "$bundle/server.crt.pem")
if bash /tmp/issue-test.sh; then echo 'FAIL: second issuance accepted'; exit 1; fi
[[ "$before" == "$(sha256sum "$bundle/server.key.pem" "$bundle/server.crt.pem")" ]]
printf '\nPASS: pinned CA, issuance, key permissions, IP rejection, no-overwrite.\n'
