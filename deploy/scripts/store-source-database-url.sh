#!/usr/bin/env bash
set -euo pipefail

secrets_dir="/opt/corestack/apps/allpa/secrets"
secret_file="${secrets_dir}/source-database.url"
project_ref="ofiajrknxhtquctgrysr"

umask 077
mkdir -p "${secrets_dir}"
chmod 700 "${secrets_dir}"

if [[ -e "${secret_file}" ]]; then
  echo "Ya existe ${secret_file}; no se sobrescribio."
  exit 1
fi

read -r -s -p "Pega la URI PostgreSQL de Supabase y presiona Enter: " database_url
echo

if [[ ! "${database_url}" =~ ^postgres(ql)?:// ]]; then
  echo "La entrada no parece una URI PostgreSQL."
  exit 1
fi

if [[ "${database_url}" != *"${project_ref}"* ]]; then
  echo "La URI no corresponde al proyecto Supabase esperado."
  exit 1
fi

if [[ "${database_url}" == *"[YOUR-PASSWORD]"* || "${database_url}" == *"YOUR_PASSWORD"* ]]; then
  echo "La URI todavia contiene el marcador de contrasena."
  exit 1
fi

temporary_file="$(mktemp "${secrets_dir}/.source-database.url.XXXXXX")"
trap 'rm -f "${temporary_file}"' EXIT
printf '%s\n' "${database_url}" > "${temporary_file}"
chmod 600 "${temporary_file}"
mv "${temporary_file}" "${secret_file}"
trap - EXIT

unset database_url
echo "Conexion de origen guardada en ${secret_file} con permisos 600."
