#!/usr/bin/env bash
set -euo pipefail

expected_hostname="VM2-APP"
network_name="allpa-network"
expected_subnet="172.21.0.0/24"
vm1_address="10.0.0.2/32"
helper_path="/usr/local/sbin/corestack-allpa-docker-firewall"
unit_path="/etc/systemd/system/corestack-allpa-docker-firewall.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script con sudo en VM2."
  exit 1
fi
if [[ "$(hostname)" != "${expected_hostname}" ]]; then
  echo "Host inesperado; se esperaba ${expected_hostname}."
  exit 1
fi

actual_subnet="$(docker network inspect "${network_name}" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
network_id="$(docker network inspect "${network_name}" --format '{{.Id}}')"
if [[ "${actual_subnet}" != "${expected_subnet}" ]]; then
  echo "Subred inesperada para ${network_name}: ${actual_subnet}"
  exit 1
fi
bridge_name="br-${network_id:0:12}"

backup_dir="/opt/corestack/backups/firewall"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 700 "${backup_dir}"
iptables-save > "${backup_dir}/iptables.before-allpa.${timestamp}.rules"
chmod 600 "${backup_dir}/iptables.before-allpa.${timestamp}.rules"
ufw status numbered > "${backup_dir}/ufw.before-allpa.${timestamp}.txt"
chmod 600 "${backup_dir}/ufw.before-allpa.${timestamp}.txt"

helper_temp="$(mktemp)"
cat > "${helper_temp}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

subnet="${expected_subnet}"
vm1_address="${vm1_address}"
bridge_name="${bridge_name}"
accept_comment="corestack-allpa-from-vm1"
drop_comment="corestack-allpa-deny-other-sources"

for attempt in \$(seq 1 30); do
  if iptables --check DOCKER-USER --jump RETURN >/dev/null 2>&1 || iptables --list DOCKER-USER >/dev/null 2>&1; then
    break
  fi
  [[ "\${attempt}" -eq 30 ]] && { echo "DOCKER-USER no esta disponible."; exit 1; }
  sleep 1
done

while iptables --check DOCKER-USER --in-interface eth1 --source "\${vm1_address}" --destination "\${subnet}" \
  --match conntrack --ctstate NEW --match comment --comment "\${accept_comment}" --jump ACCEPT >/dev/null 2>&1; do
  iptables --delete DOCKER-USER --in-interface eth1 --source "\${vm1_address}" --destination "\${subnet}" \
    --match conntrack --ctstate NEW --match comment --comment "\${accept_comment}" --jump ACCEPT
done
while iptables --check DOCKER-USER ! --in-interface "\${bridge_name}" --destination "\${subnet}" \
  --match conntrack --ctstate NEW --match comment --comment "\${drop_comment}" --jump DROP >/dev/null 2>&1; do
  iptables --delete DOCKER-USER ! --in-interface "\${bridge_name}" --destination "\${subnet}" \
    --match conntrack --ctstate NEW --match comment --comment "\${drop_comment}" --jump DROP
done

# Insert DROP first, then ACCEPT at position one so the allow rule is evaluated first.
iptables --insert DOCKER-USER 1 ! --in-interface "\${bridge_name}" --destination "\${subnet}" \
  --match conntrack --ctstate NEW --match comment --comment "\${drop_comment}" --jump DROP
iptables --insert DOCKER-USER 1 --in-interface eth1 --source "\${vm1_address}" --destination "\${subnet}" \
  --match conntrack --ctstate NEW --match comment --comment "\${accept_comment}" --jump ACCEPT
EOF
install -o root -g root -m 750 "${helper_temp}" "${helper_path}"
unlink "${helper_temp}"

unit_temp="$(mktemp)"
cat > "${unit_temp}" <<EOF
[Unit]
Description=CoreStack ALLPA Docker ingress policy
Requires=docker.service
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=${helper_path}
ExecReload=${helper_path}
RemainAfterExit=yes

[Install]
WantedBy=docker.service
EOF
install -o root -g root -m 644 "${unit_temp}" "${unit_path}"
unlink "${unit_temp}"

if ! ufw status | grep -Fq "3002/tcp"; then
  ufw allow from 10.0.0.2 to 10.0.0.3 port 3002 proto tcp comment 'ALLPA web from VM1 reverse proxy'
fi
if ! ufw status | grep -Fq "4002/tcp"; then
  ufw allow from 10.0.0.2 to 10.0.0.3 port 4002 proto tcp comment 'ALLPA API from VM1 reverse proxy'
fi

systemctl daemon-reload
systemctl enable --now corestack-allpa-docker-firewall.service
systemctl is-active --quiet corestack-allpa-docker-firewall.service
iptables --check DOCKER-USER --in-interface eth1 --source "${vm1_address}" --destination "${expected_subnet}" \
  --match conntrack --ctstate NEW --match comment --comment corestack-allpa-from-vm1 --jump ACCEPT
iptables --check DOCKER-USER ! --in-interface "${bridge_name}" --destination "${expected_subnet}" \
  --match conntrack --ctstate NEW --match comment --comment corestack-allpa-deny-other-sources --jump DROP

echo "FIREWALL_BACKUP=${backup_dir}/iptables.before-allpa.${timestamp}.rules"
echo "ALLPA_VM2_FIREWALL_INSTALLED"
