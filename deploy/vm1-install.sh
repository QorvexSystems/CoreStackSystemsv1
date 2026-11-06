#!/usr/bin/env bash
set -euo pipefail

[[ "$(hostname)" == CoreStack-VM1-Gateway && "${EUID}" -eq 0 ]] || { echo 'Ejecutar como root en VM1' >&2; exit 1; }

domain=solucionesautomotriz.corestack-systems.com
source_config=/opt/corestack/scripts/solucionesautomotriz.conf
available_config=/etc/nginx/sites-available/solucionesautomotriz.conf
enabled_config=/etc/nginx/sites-enabled/solucionesautomotriz.conf
webroot=/var/www/certbot

[[ -f "$source_config" ]] || { echo 'Falta la configuración Nginx preparada' >&2; exit 1; }
getent ahosts "$domain" >/dev/null || { echo "DNS pendiente: $domain" >&2; exit 1; }
[[ "$(curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' http://10.0.0.3:3003/login)" == 200 ]] || { echo 'Web no saludable desde VM1' >&2; exit 1; }
[[ "$(curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' http://10.0.0.3:4003/health)" == 200 ]] || { echo 'API no saludable desde VM1' >&2; exit 1; }
[[ ! -e "$available_config" && ! -e "$enabled_config" ]] || { echo 'Ya existe una configuración para este dominio; revisar antes de continuar' >&2; exit 1; }

install -d -m 755 "$webroot/.well-known/acme-challenge"
bootstrap=$(mktemp)
cat > "$bootstrap" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name solucionesautomotriz.corestack-systems.com;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 301 https://$host$request_uri; }
}
NGINX
install -m 644 "$bootstrap" "$available_config"
ln -s "$available_config" "$enabled_config"
nginx -t
systemctl reload nginx

certbot certonly --webroot --webroot-path "$webroot" \
  --domain "$domain" --cert-name "$domain" \
  --non-interactive --agree-tos

install -m 644 "$source_config" "$available_config"
if ! nginx -t; then
  install -m 644 "$bootstrap" "$available_config"
  nginx -t
  systemctl reload nginx
  echo 'HTTPS inválido; se restauró el bloque HTTP' >&2
  exit 1
fi
rm -f "$bootstrap"
systemctl reload nginx

[[ "$(curl --resolve "$domain:443:127.0.0.1" -fsS -o /dev/null -w '%{http_code}' "https://$domain/login")" == 200 ]] || { echo 'La web no respondió 200 por HTTPS' >&2; exit 1; }
[[ "$(curl --resolve "$domain:443:127.0.0.1" -fsS -o /dev/null -w '%{http_code}' "https://$domain/api/health")" == 200 ]] || { echo 'La API no respondió 200 por HTTPS' >&2; exit 1; }
echo "HTTPS instalado: $domain"
