#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM3-SQLDB' ]] || { echo RUN_WITH_SUDO_ON_VM3 >&2; exit 1; }
printf 'Pegue una contraseña aleatoria exclusiva del runtime fiscal. PostgreSQL la solicitará dos veces.\n'
sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres \
  -v ON_ERROR_STOP=1 -c '\password rivnu_fe_prod_runtime'
sudo -u postgres psql -X --no-password -h /var/run/postgresql -p 5432 -d postgres \
  -v ON_ERROR_STOP=1 -c 'ALTER ROLE rivnu_fe_prod_runtime LOGIN;'
printf 'RIVNU_FISCAL_PRODUCTION_RUNTIME_LOGIN_ENABLED\n'
