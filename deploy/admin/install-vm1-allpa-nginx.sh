#!/usr/bin/env bash
set -euo pipefail

expected_hostname="CoreStack-VM1-Gateway"
domain="allpa.corestack-systems.com"
api_domain="allpa-api.corestack-systems.com"
source_config="/opt/corestack/scripts/allpa-production.conf"
available_config="/etc/nginx/sites-available/allpa-production.conf"
enabled_config="/etc/nginx/sites-enabled/allpa-production.conf"
cert_directory="/etc/letsencrypt/live/${domain}"
webroot="/var/www/certbot"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo en VM1."
  exit 1
fi
if [[ "$(hostname)" != "${expected_hostname}" ]]; then
  echo "Host inesperado; se esperaba ${expected_hostname}."
  exit 1
fi
if [[ ! -f "${source_config}" ]]; then
  echo "Falta la configuracion final de Nginx."
  exit 1
fi
if ! getent ahosts "${domain}" >/dev/null; then
  echo "DNS_PENDING: ${domain} todavia no resuelve."
  exit 1
fi
if ! getent ahosts "${api_domain}" >/dev/null; then
  echo "DNS_PENDING: ${api_domain} todavia no resuelve."
  exit 1
fi

web_status="$(curl --connect-timeout 5 --max-time 10 --silent --output /dev/null --write-out '%{http_code}' http://10.0.0.3:3002/login)"
api_status="$(curl --connect-timeout 5 --max-time 10 --silent --output /dev/null --write-out '%{http_code}' http://10.0.0.3:4002/health)"
if [[ "${web_status}" != "200" || "${api_status}" != "200" ]]; then
  echo "Los backends ALLPA no estan saludables desde VM1."
  exit 1
fi

install -d -o root -g root -m 755 "${webroot}"
backup_dir="/opt/corestack/backups/nginx"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 700 "${backup_dir}"
if [[ -e "${available_config}" ]]; then
  install -o root -g root -m 600 "${available_config}" \
    "${backup_dir}/allpa-production.conf.before.${timestamp}"
fi

bootstrap_temp="$(mktemp)"
cat > "${bootstrap_temp}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${domain} ${api_domain};

    location ^~ /.well-known/acme-challenge/ {
        root ${webroot};
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
EOF
install -o root -g root -m 644 "${bootstrap_temp}" "${available_config}"
if [[ ! -L "${enabled_config}" ]]; then
  if [[ -e "${enabled_config}" ]]; then
    echo "Existe una configuracion habilitada que no es un enlace; no se sobrescribio."
    exit 1
  fi
  ln -s "${available_config}" "${enabled_config}"
fi
nginx -t
systemctl reload nginx

challenge_name="allpa-bootstrap-${timestamp}"
challenge_file="${webroot}/.well-known/acme-challenge/${challenge_name}"
install -d -o root -g root -m 755 "$(dirname "${challenge_file}")"
printf '%s\n' "${challenge_name}" > "${challenge_file}"
chmod 644 "${challenge_file}"
challenge_response="$(curl --connect-timeout 5 --max-time 10 --silent \
  --header "Host: ${domain}" "http://127.0.0.1/.well-known/acme-challenge/${challenge_name}")"
unlink "${challenge_file}"
if [[ "${challenge_response}" != "${challenge_name}" ]]; then
  echo "La ruta ACME local no respondio correctamente."
  exit 1
fi

if [[ ! -s "${cert_directory}/fullchain.pem" || ! -s "${cert_directory}/privkey.pem" ]]; then
  certbot certonly --webroot --webroot-path "${webroot}" \
    --domain "${domain}" --domain "${api_domain}" --cert-name "${domain}" \
    --non-interactive --agree-tos
fi
if [[ ! -s "${cert_directory}/fullchain.pem" || ! -s "${cert_directory}/privkey.pem" ]]; then
  echo "Certbot no creo el certificado esperado."
  exit 1
fi

install -o root -g root -m 644 "${source_config}" "${available_config}"
if ! nginx -t; then
  install -o root -g root -m 644 "${bootstrap_temp}" "${available_config}"
  nginx -t
  systemctl reload nginx
  echo "La configuracion HTTPS fallo; se restauro el bootstrap HTTP."
  exit 1
fi
unlink "${bootstrap_temp}"
systemctl reload nginx

local_web_status="$(curl --resolve "${domain}:443:127.0.0.1" --silent --show-error \
  --output /dev/null --write-out '%{http_code}' "https://${domain}/login")"
local_api_status="$(curl --resolve "${api_domain}:443:127.0.0.1" --silent --show-error \
  --output /dev/null --write-out '%{http_code}' "https://${api_domain}/health")"
if [[ "${local_web_status}" != "200" || "${local_api_status}" != "200" ]]; then
  echo "La validacion HTTPS local no devolvio 200."
  exit 1
fi

echo "ALLPA_WEB_STATUS=${local_web_status}"
echo "ALLPA_API_STATUS=${local_api_status}"
echo "ALLPA_NGINX_TLS_INSTALLED"
