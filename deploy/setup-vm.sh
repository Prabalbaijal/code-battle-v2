#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server (Oracle Always Free ARM VM or Azure x86 VM) for Code Battle.
# Run from the repository folder on the server:   bash deploy/setup-vm.sh <your-domain>
# Safe to run again. See DEPLOY.md for the whole procedure.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: bash deploy/setup-vm.sh <your-domain>   (e.g. codebattle.duckdns.org)" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
REPO="$(pwd)"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

step "1/6 Swap (4 GB): image builds need headroom on small machines"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

step "2/6 Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
DOCKER="sudo docker"

step "3/6 Firewall: open 80 and 443 if the host itself blocks them"
# Oracle's Ubuntu image ends INPUT with a REJECT rule (only SSH gets through); Azure's has none, its
# firewall is the network security group. Insert before that REJECT, and only when there is one.
reject_at="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
if [[ -n "$reject_at" ]]; then
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
      sudo iptables -I INPUT "$reject_at" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  done
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent >/dev/null
  sudo netfilter-persistent save >/dev/null
  echo "Also open 80 and 443 in your cloud's firewall (Oracle: VCN → Security list), see DEPLOY.md."
else
  echo "No host firewall rule blocks them; open 80 and 443 in your cloud's firewall (Azure: NSG), see DEPLOY.md."
fi

step "4/6 Secrets (infra/prod/.env)"
if [[ ! -f infra/prod/.env ]]; then
  $DOCKER run --rm -u "$(id -u):$(id -g)" -v "$REPO:/repo" -w /repo node:22-slim \
    node scripts/gen-prod-env.mjs --domain "$DOMAIN"
  echo
  echo "Edit infra/prod/.env now and fill in every FILL_ME value (nano infra/prod/.env)."
  echo "Then run this script again to start everything."
  exit 0
fi
if grep -q FILL_ME infra/prod/.env; then
  echo "infra/prod/.env still has FILL_ME values: fill them in (nano infra/prod/.env) and run again." >&2
  exit 1
fi
chmod 600 infra/prod/.env

step "5/6 Build and start (the first build takes 15–30 minutes)"
COMPOSE=("$DOCKER" compose -f infra/compose.prod.yml --env-file infra/prod/.env)
COMPOSE_PARALLEL_LIMIT=2 "${COMPOSE[@]}" build
"${COMPOSE[@]}" up -d
echo "Waiting for the site to become healthy…"
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" ps --format '{{.Service}} {{.Health}}' | grep -q 'web healthy'; then break; fi
  sleep 10
done
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

step "6/6 Nightly backup at 03:15 (keeps 14 days in /srv/cb-backups)"
sudo mkdir -p /srv/cb-backups && sudo chown "$USER" /srv/cb-backups
CRON="15 3 * * * cd $REPO && $DOCKER run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $REPO:/repo -v /srv/cb-backups:/backups -w /repo -e BACKUP_DIR=/backups -e BACKUP_KEEP=14 -e COMPOSE_FILE=infra/compose.prod.yml -e COMPOSE_ENV_FILE=infra/prod/.env docker:28-cli sh -c 'apk add -q nodejs && node infra/backup/backup.mjs' >> /srv/cb-backups/backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'infra/backup/backup.mjs' ; echo "$CRON" ) | crontab -

echo
echo "Done. Open https://$DOMAIN (the HTTPS certificate can take a minute on the first visit)."
