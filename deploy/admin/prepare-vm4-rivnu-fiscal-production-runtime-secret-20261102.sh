#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'CoreStackSystems-VM4-Billing' ]] || { echo RUN_WITH_SUDO_ON_VM4 >&2; exit 1; }
group='4101'
destination='/opt/corestack/secrets/rivnu-fiscal-production'
read -r -s -p 'Contraseña asignada a rivnu_fe_prod_runtime en VM3: ' first; printf '\n'
read -r -s -p 'Repita exactamente la misma contraseña: ' second; printf '\n'
[[ "$first" == "$second" && ${#first} -ge 32 && ${#first} -le 256 && "$first" != *$'\n'* && "$first" != *$'\r'* ]] || { unset first second; echo SECRET_INVALID >&2; exit 1; }
install -d -o root -g "$group" -m 0750 "$destination"
temporary=$(mktemp "$destination/.postgresql.password.XXXXXX")
printf '%s' "$first" >"$temporary"
unset first second
chown root:"$group" "$temporary"
chmod 0440 "$temporary"
mv -T "$temporary" "$destination/postgresql.password"
printf 'RIVNU_FISCAL_PRODUCTION_RUNTIME_SECRET_STORED\n'
