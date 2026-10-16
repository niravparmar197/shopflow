#!/bin/bash
# First boot of the Stage 1 box (Amazon Linux 2023). Idempotent: safe to re-run.
# The app itself is NOT started here; the first deploy (deploy.sh via SSM) does that.
set -euxo pipefail
REGION=ap-southeast-2
COMPOSE_VERSION=v2.29.7

# ---- Docker + Compose plugin ----
dnf install -y docker jq
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
if [ ! -x /usr/local/lib/docker/cli-plugins/docker-compose ]; then
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
# Container logs: rotate, so a chatty service cannot fill the disk.
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "3" } }
JSON
systemctl restart docker

# ---- 2 GiB swap: a safety net for memory spikes (Kafka + 7 Node services) ----
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a || true

# ---- DuckDNS: point the domain at THIS box's current public IP ----
# No Elastic IP, so the IP changes on every stop/start. Run on boot + every 5 min.
cat > /usr/local/bin/duckdns-update <<'SH'
#!/bin/bash
set -euo pipefail
get() { aws ssm get-parameter --region ap-southeast-2 --with-decryption --name "/shopflow/prod/$1" --query Parameter.Value --output text; }
DOMAIN=$(get DUCKDNS_SUBDOMAIN) || exit 0   # secrets not uploaded yet: skip quietly
TOKEN=$(get DUCKDNS_TOKEN) || exit 0
# Empty ip= → DuckDNS uses the address the request came from (our public IP).
RESULT=$(curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=")
echo "duckdns ${DOMAIN}: ${RESULT}"
[ "$RESULT" = "OK" ]
SH
chmod 700 /usr/local/bin/duckdns-update

cat > /etc/systemd/system/duckdns.service <<'UNIT'
[Unit]
Description=Update DuckDNS with this box's public IP
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/duckdns-update
UNIT
cat > /etc/systemd/system/duckdns.timer <<'UNIT'
[Unit]
Description=DuckDNS update on boot and every 5 minutes
[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now duckdns.timer

# ---- App folders ----
mkdir -p /opt/shopflow/releases /opt/shopflow/keys
chmod 700 /opt/shopflow/keys
echo "user-data done" > /opt/shopflow/.bootstrapped
