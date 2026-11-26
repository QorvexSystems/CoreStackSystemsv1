#!/usr/bin/env bash
# Disposable PostgreSQL only. No real certificates, credentials or host mounts.
set -euo pipefail
umask 077
[[ -f /.dockerenv && "$(hostname)" == VM3-SQLDB ]] || exit 1
[[ "$(stat -f -c '%T' /var/lib/corestack-pki)" == tmpfs ]] || exit 1
readonly pki=/var/lib/corestack-pki
readonly bundle="$pki/issued/vm3-postgresql-2026"
mkdir -p "$bundle" /usr/local/share/corestack-pki /etc/postgresql/17/main /etc/ssl/private
chmod 0700 "$pki" "$bundle"
openssl req -new -x509 -newkey rsa:2048 -nodes -days 730 -subj /CN=TestCA \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout /tmp/test-ca.key -out /usr/local/share/corestack-pki/internal-root-2026.crt 2>/dev/null
openssl req -new -x509 -newkey rsa:2048 -nodes -days 365 -subj /CN=OldTest \
  -keyout /etc/ssl/private/ssl-cert-snakeoil.key -out /etc/ssl/certs/ssl-cert-snakeoil.pem 2>/dev/null
chown postgres:postgres /etc/ssl/private/ssl-cert-snakeoil.key
chmod 0600 /etc/ssl/private/ssl-cert-snakeoil.key
chmod 0644 /etc/ssl/certs/ssl-cert-snakeoil.pem
chmod 0755 /etc/ssl/private
openssl req -new -newkey rsa:2048 -nodes -subj /CN=VM3-SQLDB \
  -keyout "$bundle/server.key.pem" -out /tmp/test.csr 2>/dev/null
openssl x509 -req -in /tmp/test.csr -CA /usr/local/share/corestack-pki/internal-root-2026.crt \
  -CAkey /tmp/test-ca.key -set_serial 1234 -days 365 \
  -extfile /work/tls/vm3-postgresql-request.cnf -extensions server_extensions \
  -out "$bundle/server.crt.pem" 2>/dev/null
if [[ "${1:-happy}" == integration ]]; then
  sed '/IP.1 =/a IP.2 = 127.0.0.1' /work/tls/vm3-postgresql-request.cnf > /tmp/test-server.cnf
  openssl x509 -req -in /tmp/test.csr -CA /usr/local/share/corestack-pki/internal-root-2026.crt \
    -CAkey /tmp/test-ca.key -set_serial 1234 -days 365 -extfile /tmp/test-server.cnf \
    -extensions server_extensions -out "$bundle/server.crt.pem" 2>/dev/null
fi
chmod 0400 "$bundle/server.key.pem"
fp() { openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d = -f 2; }
sed -e "s/^readonly expected_ca=.*/readonly expected_ca='$(fp /usr/local/share/corestack-pki/internal-root-2026.crt)'/" \
  -e "s/^readonly expected_leaf=.*/readonly expected_leaf='$(fp "$bundle/server.crt.pem")'/" \
  -e "s/^readonly expected_old=.*/readonly expected_old='$(fp /etc/ssl/certs/ssl-cert-snakeoil.pem)'/" \
  /work/admin/activate-vm3-postgresql-tls.sh > /tmp/activate-test.sh
install -d -o postgres -g postgres -m 0700 /tmp/testpg
sudo -u postgres initdb -D /tmp/testpg -A trust >/dev/null
cp /tmp/testpg/postgresql.conf /etc/postgresql/17/main/postgresql.conf
cp /tmp/testpg/pg_hba.conf /etc/postgresql/17/main/pg_hba.conf
chmod 0644 /etc/postgresql/17/main/pg_hba.conf
printf "\nhba_file='/etc/postgresql/17/main/pg_hba.conf'\n" >> /etc/postgresql/17/main/postgresql.conf
printf "\ndata_directory='/tmp/testpg'\nlisten_addresses='127.0.0.1'\nssl=on\nssl_cert_file='/etc/ssl/certs/ssl-cert-snakeoil.pem'\nssl_key_file='/etc/ssl/private/ssl-cert-snakeoil.key'\n" >> /etc/postgresql/17/main/postgresql.conf
chmod 0644 /etc/postgresql/17/main/postgresql.conf
chmod 0755 /etc/postgresql /etc/postgresql/17 /etc/postgresql/17/main
sudo -u postgres pg_ctl -D /tmp/testpg -l /tmp/testpg/server.log \
  -o '-c config_file=/etc/postgresql/17/main/postgresql.conf -k /var/run/postgresql' -w start >/dev/null \
  || { tail -n 30 /tmp/testpg/server.log; exit 1; }
original=$(sha256sum /etc/postgresql/17/main/postgresql.conf)
if [[ "${1:-happy}" == override ]]; then
  # Simulate a higher-priority setting unknown to the simple main-file append.
  printf "ssl_cert_file='/etc/ssl/certs/ssl-cert-snakeoil.pem'\n" >> /tmp/testpg/postgresql.auto.conf
  if bash /tmp/activate-test.sh activate; then echo 'FAIL: override accepted'; exit 1; fi
  [[ "$original" == "$(sha256sum /etc/postgresql/17/main/postgresql.conf)" ]]
  echo 'PASS: precedence conflict rejected and original restored.'
else
  bash /tmp/activate-test.sh activate
  if [[ "${1:-happy}" == fiscal || "${1:-happy}" == integration ]]; then
    bash /work/tls/test-vm3-fiscal-database.sh
    if [[ "${1:-happy}" == integration ]]; then
      install -d /tmp/fiscal-installer/fiscal-persistence-20260921
      cp /work/admin/install-vm3-fiscal-persistence.sh /tmp/fiscal-installer/
      cp /fiscal/sql/00*.sql /tmp/fiscal-installer/fiscal-persistence-20260921/
      bash /tmp/fiscal-installer/install-vm3-fiscal-persistence.sh
      sudo -u postgres createdb -h /var/run/postgresql fiscal_backup_restore_test
      # Synthetic DB backup only, restore into a separate disposable database.
      sudo -u postgres pg_restore -h /var/run/postgresql -d fiscal_backup_restore_test \
        < /var/lib/corestack-pki/fiscal-persistence-install-20260921/pre-migration.dump
      [[ "$(sudo -u postgres psql -X -h /var/run/postgresql -d fiscal_backup_restore_test -Atqc 'SELECT count(*) FROM fiscal_meta.issuer_scope')" == 1 ]]
      echo FISCAL_BACKUP_RESTORE_TESTED
      sudo -u postgres psql -X -h /var/run/postgresql -d rivnu_fiscal_pre -v ON_ERROR_STOP=1 -c "ALTER ROLE rivnu_fe_pre_runtime LOGIN; SET ROLE rivnu_fe_pre_owner; SELECT corestack_fiscal.register_range('cmqn0r66a0002lit0vxbzq5l4','40220429126','precertification',31::smallint,1,100,'2026-01-01','2027-12-31','SYNTHETIC-INTEGRATION-ONLY');"
      sed -i 's/10.0.0.1\/32/127.0.0.1\/32/' /etc/postgresql/17/main/pg_hba.conf
      sudo -u postgres psql -X -h /var/run/postgresql -d postgres -c 'SELECT pg_reload_conf();'
      chmod 0644 /usr/local/share/corestack-pki/internal-root-2026.crt
      echo FISCAL_INTEGRATION_FIXTURE_READY
      exec tail -f /dev/null
    fi
    exit 0
  fi
  [[ "$(stat -c '%U:%G:%a' /etc/corestack-postgresql-tls-2026/server.key.pem)" == root:postgres:640 ]]
  # Guard manual rollback against overwriting an administrator's later edit.
  printf '\n# intervening edit\n' >> /etc/postgresql/17/main/postgresql.conf
  if bash /tmp/activate-test.sh rollback; then echo 'FAIL: later edit overwritten'; exit 1; fi
  sed -i '$d' /etc/postgresql/17/main/postgresql.conf
  sed -i '$d' /etc/postgresql/17/main/postgresql.conf
  bash /tmp/activate-test.sh rollback
  [[ "$original" == "$(sha256sum /etc/postgresql/17/main/postgresql.conf)" ]]
  if bash /tmp/activate-test.sh activate; then echo 'FAIL: repeated activation allowed'; exit 1; fi
  echo 'PASS: live TLS activation, permissions, guarded rollback, old certificate restored, no overwrite.'
fi
