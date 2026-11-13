# Deploying Code Battle

A step-by-step guide you can follow on your own. Everything runs on **one machine** with Docker:
the services, Postgres, Redis, Redpanda, and Caddy in front (automatic HTTPS). Cost: ₹0.

- **Option A (recommended): Oracle Always Free VM**, always on.
- **Option B: your laptop + Cloudflare Tunnel**, for demos while you wait for Oracle.

Files involved: `infra/compose.prod.yml`, `infra/prod/Caddyfile`, `scripts/gen-prod-env.mjs`,
`deploy/setup-vm.sh`, `deploy/oci-retry.ps1`. Secrets live only in `infra/prod/.env` on the server
(never commit or share it).

---

## Before you start (both options)

1. **RapidAPI Judge0 key.** The old key appeared in a screenshot: on RapidAPI, open the Judge0 CE
   app → **Regenerate key**, and use the new one. Free plan = **50 requests a day**; a submission
   uses about 2, so roughly 20 judged submissions a day. Problem calibration also uses requests.
2. **Brevo (email).** In Brevo: **Senders & IP → Senders → Add a sender** (verify the email it sends
   you), then **SMTP & API → API keys → Generate**. You'll paste the key and the sender address
   into `infra/prod/.env`.
3. **A domain name (free).** Go to <https://www.duckdns.org>, log in with Google or GitHub, create a
   subdomain (e.g. `codebattle` → `codebattle.duckdns.org`). For option A, put the VM's public IP in
   its "current ip" box and click **update ip**.

---

## Try it on your laptop first (optional)

The production setup runs on your laptop as well (Docker Desktop), at **https://localhost**:

```powershell
# stop the dev stack first (same ports and RAM), then in the repo folder:
node scripts/gen-prod-env.mjs --domain localhost
notepad infraprod.env      # fill JUDGE0_API_KEY, BREVO_API_KEY, EMAIL_FROM
docker compose -f infra/compose.prod.yml --env-file infra/prod/.env up -d --build
```

The browser warns about the certificate (Caddy made a local one): **Advanced → Proceed**. It is
real production mode: verification emails go out through Brevo and submissions use your Judge0
allowance. When you're done:

```powershell
docker compose -f infra/compose.prod.yml --env-file infra/prod/.env down -v   # -v: delete this test's data
Remove-Item infraprod.env
```

The database passwords are set **once**, when the database is first created. Never regenerate
`infra/prod/.env` (`--force`) while its database volume still exists: the services couldn't log in.
Delete the volume first (`down -v`, which also deletes the data), or keep the old file.

---

## Option A: Oracle Always Free VM

### A1. Get the server

In the Oracle console, create an instance: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex**
(1 OCPU / 6 GB is fine to start; up to 4 / 24 GB is free), public IPv4 on, save the SSH key pair.

If it says **"Out of capacity"** (common in Mumbai), let your laptop retry for you:

1. Install the OCI CLI (PowerShell):
   `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.ps1'))"`
2. `oci setup config` (user OCID and tenancy OCID from the console: profile icon → My profile /
   Tenancy; region `ap-mumbai-1`; let it generate an API key), then in the console **My profile →
   API keys → Add API key** and paste `C:\Users\<you>\.oci\oci_api_key_public.pem`.
3. Make sure a network exists: **Networking → Virtual cloud networks** (if empty: **Start VCN
   Wizard → Create VCN with Internet Connectivity**).
4. Run, from the repo folder:
   `powershell -ExecutionPolicy Bypass -File deploy\oci-retry.ps1 -SshPublicKey C:\path\to\ssh-key.pub`
   Leave it running (laptop plugged in). It prints the public IP when it succeeds.

### A2. Open ports 80 and 443 in Oracle

Console → **Networking → Virtual cloud networks →** your VCN **→ Security Lists → Default
Security List → Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination port `80`. Add the same
for `443`. (The setup script opens them in the server's own firewall too.)

### A3. Point your domain at the server

On duckdns.org, put the server's public IP and click **update ip**. Check from your laptop:
`nslookup codebattle.duckdns.org` should print that IP.

### A4. Put the code on the server

```sh
ssh -i C:\path\to\ssh-key ubuntu@<server-ip>
# on the server:
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Prabalbaijal/code-battle-v2.git
cd code-battle-v2
```

The repository is private, so `git clone` asks for a username and password. Use your GitHub
username and a **fine-grained personal access token** as the password (GitHub → Settings →
Developer settings → Personal access tokens → Fine-grained → only this repository, **Contents:
read-only**).

### A5. Run the setup

```sh
bash deploy/setup-vm.sh codebattle.duckdns.org
```

The first run installs Docker, opens the firewall and writes `infra/prod/.env`, then stops. Fill it in:

```sh
nano infra/prod/.env     # set JUDGE0_API_KEY, BREVO_API_KEY, EMAIL_FROM (Ctrl+O to save, Ctrl+X to exit)
bash deploy/setup-vm.sh codebattle.duckdns.org
```

The second run builds everything (15–30 minutes the first time), starts it, and adds a nightly
backup. Open **https://codebattle.duckdns.org**.

### A6. Make yourself admin and add problems

1. Register on the site and verify your email.
2. On the server:
   ```sh
   sudo docker compose -f infra/compose.prod.yml --env-file infra/prod/.env exec postgres \
     psql -U cb -d identity -c "update credentials set role='admin' where username='YOUR_USERNAME';"
   ```
3. Log out and log in again. **Problems** appears in the header: create a problem, upload its
   tests and reference solutions, calibrate, publish. A match needs a published problem neither
   player has seen, so publish several.

---

## Option B: your laptop + Cloudflare Tunnel (demos)

Works today, but the site is online only while the laptop is on.

1. Docker Desktop running; in the repo folder:
   `node scripts/gen-prod-env.mjs --domain placeholder.example --tunnel`
   and fill in the FILL_ME values in `infra/prod/.env` (leave `CLOUDFLARE_TUNNEL_TOKEN` empty).
2. Start the stack:
   `docker compose -f infra/compose.prod.yml --env-file infra/prod/.env up -d --build`
3. Start a free quick tunnel (no account needed):
   `docker run --rm --network code-battle-prod_cb cloudflare/cloudflared:2025.11.1 tunnel --no-autoupdate --url http://caddy:80`
   It prints a URL like `https://random-words.trycloudflare.com`.
4. Put that host name in `infra/prod/.env` as `DOMAIN=random-words.trycloudflare.com` and apply:
   `docker compose -f infra/compose.prod.yml --env-file infra/prod/.env up -d`
   The URL changes every time the tunnel restarts; repeat step 4 when it does.

(With a domain of your own on Cloudflare you can create a named tunnel instead, put its token in
`CLOUDFLARE_TUNNEL_TOKEN` and run with `--profile tunnel`: the URL then stays fixed.)

---

## Everyday commands (on the server, in the repo folder)

```sh
alias cb='sudo docker compose -f infra/compose.prod.yml --env-file infra/prod/.env'
cb ps                       # what's running and healthy
cb logs -f --tail 100 judge-worker     # follow one service's logs
cb restart battle           # restart one service
git pull && cb up -d --build           # deploy a new version (migrations run automatically)
```

**Backups:** nightly at 03:15 into `/srv/cb-backups` (14 days). Test a restore once a month:

```sh
sudo docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v $PWD:/repo -v /srv/cb-backups:/backups \
  -w /repo -e COMPOSE_FILE=infra/compose.prod.yml -e COMPOSE_ENV_FILE=infra/prod/.env docker:28-cli \
  sh -c 'apk add -q nodejs && node infra/backup/restore.mjs /backups/<timestamp>'
```

Copy `/srv/cb-backups` off the server now and then (e.g. `scp -r` to your laptop): a backup on the
same disk doesn't survive losing the server. Disaster recovery steps: `infra/backup/README.md`.

**Monitoring:** `cb --profile obs up -d`, then from your laptop
`ssh -i <key> -L 3001:localhost:3001 ubuntu@<server-ip>` and open <http://localhost:3001>
(user `admin`, password `GRAFANA_ADMIN_PASSWORD` from `infra/prod/.env`).

## If something goes wrong

| Symptom                              | Check                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Site doesn't open at all             | `cb ps` (all healthy?), ports 80/443 in the Oracle security list, DuckDNS points to the current IP |
| Certificate error on the first visit | wait a minute: Caddy is getting the certificate (`cb logs caddy`)                                  |
| A service keeps restarting           | `cb logs <service>`: usually a missing or wrong value in `infra/prod/.env`                         |
| No verification emails               | `cb logs notification-worker`; is `EMAIL_FROM` a verified sender in Brevo, is the API key right?   |
| "The judge is at capacity for today" | the 50/day RapidAPI requests are used up; it resets at midnight UTC                                |
| "No new problems for this pair"      | publish more problems                                                                              |
| Server ran out of memory             | resize the instance (Edit → Shape, up to 4 OCPU / 24 GB free) or check `cb stats`                  |

Never delete the Docker volumes (`cb down -v`) on the server: they hold the database.
