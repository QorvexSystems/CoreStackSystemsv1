#!/usr/bin/env bash
# Read-only inventory. No sudo, installs, firewall edits, secret contents or .env dumps.
set -u
printf '\nHost\n'
hostname
id
uname -srmo
printf '\nResources\n'
free -h
df -h / /opt/corestack
printf '\nFiscal paths (metadata only)\n'
for fiscal_path in /opt/corestack/fe /opt/corestack/fe/compose /opt/corestack/fe/config \
  /opt/corestack/fe/data /opt/corestack/fe/logs /opt/corestack/secrets \
  /opt/corestack/backups /opt/corestack/scripts; do
  stat -c '%A %U:%G %n' "$fiscal_path" || true
done
printf '\nDocker version/security and compose\n'
docker info --format 'Version={{.ServerVersion}} Security={{json .SecurityOptions}} Logging={{.LoggingDriver}}' || true
docker compose version || true
printf '\nContainers (no environment variables)\n'
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' || true
printf '\nFiscal network\n'
docker network inspect fiscal-network --format 'Driver={{.Driver}} Internal={{.Internal}} IPAM={{json .IPAM.Config}} Containers={{len .Containers}}' || true
printf '\nHost routes and listeners\n'
ip -4 route || true
ss -lnt || true
printf '\nTime synchronization\n'
timedatectl show -p NTPSynchronized -p Timezone || true
printf '\nAutomatic updates service (if installed)\n'
systemctl is-enabled unattended-upgrades.service || true
printf '\nFirewall visibility (no privilege elevation)\n'
if command -v ufw >/dev/null; then ufw status verbose || true; fi
if [[ -n "${FISCAL_DB_HOST:-}" ]]; then
  printf '\nExplicit DB destination TCP probe (not authentication or TLS verification)\n'
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/5432"' _ "$FISCAL_DB_HOST" && printf 'TCP 5432 reachable\n' || printf 'TCP 5432 not reachable\n'
fi
printf '\nAudit finished; no configuration changed. Missing permissions are unresolved checks, not passed checks.\n'
