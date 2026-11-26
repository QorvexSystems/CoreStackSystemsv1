#!/usr/bin/env bash
# Synthetic container-only test. Never run this on VM3 or VM4.
set -euo pipefail
umask 077
[[ -f /.dockerenv && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || exit 1
[[ "$(stat -f -c '%T' /opt/corestack/secrets)" == tmpfs ]] || exit 1
[[ "$(stat -f -c '%T' /var/lib/corestack-pki)" == tmpfs ]] || exit 1
mkdir -p /opt/corestack/fe/config /usr/local/share/corestack-pki
bash /work/admin/prepare-vm4-registration-tls.sh
[[ "$(stat -c '%u:%g:%a' /opt/corestack/secrets/rivnu-fe-registration-tls.key)" == 1000:1000:400 ]]
if bash /work/admin/prepare-vm4-registration-tls.sh; then echo 'FAIL: private key overwritten'; exit 1; fi
mkdir -p /var/lib/corestack-pki/internal-root-2026/private
openssl req -new -x509 -newkey rsa:2048 -days 730 -subj /CN=SyntheticCA \
 -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
 -passout pass:synthetic-test-only \
 -keyout /var/lib/corestack-pki/internal-root-2026/private/ca.key.pem \
 -out /var/lib/corestack-pki/internal-root-2026/ca.crt.pem 2>/dev/null
fingerprint=$(openssl x509 -in /var/lib/corestack-pki/internal-root-2026/ca.crt.pem -noout -fingerprint -sha256 | cut -d= -f2)
# Only the disposable fixture replaces the real host/CA pin.
sed -e 's/== VM3-SQLDB/== CoreStackSystems-VM4-Billing/' \
 -e "s/^readonly expected_ca=.*/readonly expected_ca='$fingerprint'/" \
 /work/admin/issue-vm4-registration-certificate.sh > /tmp/issue-test.sh
printf '%s\n' synthetic-test-only | bash /tmp/issue-test.sh /opt/corestack/fe/config/rivnu-fe-registration.csr.pem
openssl x509 -in /usr/local/share/corestack-pki/rivnu-fe-registration-2026.crt -pubkey -noout > /tmp/cert-public.pem
openssl pkey -in /opt/corestack/secrets/rivnu-fe-registration-tls.key -pubout > /tmp/key-public.pem
cmp /tmp/cert-public.pem /tmp/key-public.pem
if bash /tmp/issue-test.sh /opt/corestack/fe/config/rivnu-fe-registration.csr.pem; then echo 'FAIL: issued certificate overwritten'; exit 1; fi
echo 'PASS: protected VM4 key, matching public CSR/certificate, encrypted synthetic CA, pinned issuance, no overwrites.'
