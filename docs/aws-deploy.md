# Deploy AWS Lightsail

Runbook per deploy e manutenzione della produzione Padel TOPFLY.

## Stato Attuale

- Provider: AWS Lightsail.
- Account AWS: TOPFLY.
- Istanza: `padel-topfly`.
- Regione: Frankfurt, `eu-central-1`.
- Piano: 1 GB RAM, 2 vCPU, 40 GB SSD.
- Static IP: `18.194.7.194`.
- Dominio: `padel.topflysolutions.com`.
- HTTPS: Caddy + Let's Encrypt.
- Directory server: `/opt/padel-topfly`.
- Repo: `https://github.com/Topfly-srl/padel-topfly.git`.

## DNS

Il DNS di `topflysolutions.com` e' gestito da cPanel/Serverplan.

Record richiesto:

```txt
Tipo: A
Nome: padel
Valore: 18.194.7.194
TTL: default oppure 300
```

Verifica:

```bash
dig +short A padel.topflysolutions.com
curl -I https://padel.topflysolutions.com
curl -I http://padel.topflysolutions.com
```

Atteso:

```txt
padel.topflysolutions.com -> 18.194.7.194
https://padel.topflysolutions.com -> HTTP/2 200
http://padel.topflysolutions.com -> 308 Permanent Redirect
```

## Firewall Lightsail

Porte IPv4 aperte:

```txt
SSH    TCP 22
HTTP   TCP 80
HTTPS  TCP 443
```

Porte IPv6 aperte, se IPv6 resta attivo:

```txt
SSH    TCP 22
HTTP   TCP 80
HTTPS  TCP 443
```

Non serve load balancer.
Non serve CDN.
Non serve database gestito per la V1.

## Bootstrap Server

Comandi usati per preparare una nuova istanza Ubuntu:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git tmux
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Su istanze piccole conviene aggiungere swap:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
free -h
```

Per rendere la swap persistente dopo reboot, aggiungere a `/etc/fstab`:

```txt
/swapfile none swap sw 0 0
```

## Struttura Docker

`docker-compose.production.yml` avvia:

- `app`: immagine Next.js buildata dal `Dockerfile`;
- `postgres`: `postgres:16-alpine`, volume `padel_topfly_pgdata`;
- `caddy`: `caddy:2-alpine`, porte `80` e `443`.

L'entrypoint dell'app esegue automaticamente:

```bash
npx prisma migrate deploy
npm start
```

Il database locale e' persistente grazie al volume Docker:

```txt
padel_topfly_pgdata
```

Hardening attivo per il servizio `app`:

- container eseguito come utente non-root;
- `security_opt: no-new-privileges:true`;
- `cap_drop: ALL`.

Next imposta gli header di sicurezza sulle risposte applicative. Caddy li mantiene
anche a livello proxy e sovrascrive `X-Real-IP` / `X-Forwarded-For` con il client IP
reale prima di inoltrare la richiesta all'app.

## Env Produzione

Creare il file sul server:

```bash
cd /opt/padel-topfly
cp .env.production.example .env.production
chmod 600 .env.production
```

Generare segreti:

```bash
openssl rand -base64 32
openssl rand -hex 24
```

Per `POSTGRES_PASSWORD` usare preferibilmente un valore hex, cosi' non serve URL encoding dentro `DATABASE_URL`.

Configurazione dominio reale:

```env
APP_DOMAIN=padel.topflysolutions.com
APP_ENV=production
APP_PUBLIC_ORIGIN=https://padel.topflysolutions.com
APP_ALLOWED_DOMAIN=topflysolutions.com
APP_ADMIN_EMAILS=antony.buffone@topflysolutions.com
APP_TIME_ZONE=Europe/Rome

AUTH_DEV_MODE=false
AUTH_TRUST_HOST=true
AUTH_URL=https://padel.topflysolutions.com
AUTH_SECRET=...

POSTGRES_USER=padel
POSTGRES_PASSWORD=...
POSTGRES_DB=padel_topfly
DATABASE_URL=postgresql://padel:...@postgres:5432/padel_topfly?schema=public

MICROSOFT_ENTRA_ID_ID=...
MICROSOFT_ENTRA_ID_SECRET=...
MICROSOFT_ENTRA_ID_TENANT_ID=...

MS_GRAPH_TENANT_ID=
MS_GRAPH_CLIENT_ID=
MS_GRAPH_CLIENT_SECRET=
MS_GRAPH_MAILBOX=padel@topflysolutions.com
APP_WAIVER_RECIPIENT_EMAIL=padel@topflysolutions.com
```

Attenzione:

- `APP_DOMAIN` con dominio HTTPS non deve avere `:` davanti.
- Corretto: `APP_DOMAIN=padel.topflysolutions.com`.
- Errato: `APP_DOMAIN=:padel.topflysolutions.com`.
- `APP_DOMAIN=:80` e' valido solo per test temporanei via IP e HTTP.

## Deploy Con GitHub Actions

Il metodo consigliato e attualmente attivo e' il workflow GitHub Actions
`Deploy Production`.

Quando i repository secrets SSH sono configurati e la repository variable
`PRODUCTION_AUTO_DEPLOY=true` e' presente, ogni push su `main` aggiorna automaticamente
Lightsail dopo CI (`lint`, test, build, Prisma validate e audit npm).

Nel repo TOPFLY questi valori sono gia' configurati e il workflow e' stato testato con
esito positivo. La procedura completa per ruotare la chiave SSH dedicata, configurare di
nuovo secrets/variable e usare il fallback manuale e' in
[`docs/production-runbook.md`](production-runbook.md).

## Deploy Manuale

Prima di deployare una patch importante, creare un backup DB:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 -o "$(whoami)" -g "$(id -gn)" "$BACKUP_DIR"
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly \
  > "$BACKUP_DIR/padel_topfly_$(date +%Y%m%d-%H%M%S).sql" < /dev/null
ls -lh "$BACKUP_DIR" | tail
```

Sul server:

```bash
cd /opt/padel-topfly
git pull --ff-only origin main
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
```

Se il browser SSH di Lightsail cade durante la build, usare `tmux`:

```bash
tmux new -s deploy
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
```

Per rientrare:

```bash
tmux attach -t deploy
```

## Deploy Da Mac

Se si usa una chiave SSH locale:

```bash
AWS_HOST=18.194.7.194 AWS_USER=ubuntu ./scripts/deploy-aws.sh
```

Lo script:

1. clona o aggiorna la repo;
2. verifica che `.env.production` esista;
3. crea un backup DB in `/var/backups/padel-topfly` se Postgres e' gia' in esecuzione;
4. esegue `git pull --ff-only origin main`;
5. esegue `sudo docker compose up -d --build`;
6. riavvia Caddy per ricaricare configurazione e security header;
7. mostra lo stato container.

Se Docker non richiede `sudo`, usare:

```bash
AWS_HOST=18.194.7.194 AWS_USER=ubuntu DOCKER_COMPOSE="docker compose" ./scripts/deploy-aws.sh
```

## Aggiornare Solo Env

Prima backup:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 "$BACKUP_DIR"
sudo cp .env.production "$BACKUP_DIR/.env.production.backup.$(date +%Y%m%d-%H%M%S)"
sudo nano .env.production
```

Poi ricreare l'app:

```bash
sudo docker compose -f docker-compose.production.yml up -d --force-recreate app
sudo docker compose -f docker-compose.production.yml ps
```

Per cambio dominio/Caddy:

```bash
sudo docker compose -f docker-compose.production.yml up -d
sudo docker compose -f docker-compose.production.yml logs -f caddy
```

## Log E Debug

Stato container:

```bash
sudo docker compose -f docker-compose.production.yml ps
sudo docker ps -a
```

Log:

```bash
sudo docker compose -f docker-compose.production.yml logs -f app
sudo docker compose -f docker-compose.production.yml logs -f caddy
sudo docker compose -f docker-compose.production.yml logs -f postgres
```

Uscire da `logs -f` con `CTRL+C`. I container restano attivi.

## Problemi Gia' Incontrati

### Build Docker molto lenta

Sintomi:

- build ferma per molti minuti su `npm ci` o `Running TypeScript`.

Azioni:

- usare `tmux`;
- aggiungere swap 2 GB;
- assicurarsi di avere il Dockerfile ottimizzato con `npm prune --omit=dev`.

### Caddy invalid port

Errore:

```txt
invalid port 'padel.topflysolutions.com'
```

Causa:

- `APP_DOMAIN=:padel.topflysolutions.com`.

Fix:

```env
APP_DOMAIN=padel.topflysolutions.com
```

Poi:

```bash
sudo docker compose -f docker-compose.production.yml up -d
sudo docker compose -f docker-compose.production.yml logs -f caddy
```

### HTTPS non parte

Controllare:

- DNS `A` punta a `18.194.7.194`;
- porte `80` e `443` aperte su Lightsail;
- `APP_DOMAIN=padel.topflysolutions.com`;
- log Caddy.

## Bitwarden

Checklist dettagliata: [`docs/bitwarden-checklist.md`](bitwarden-checklist.md).

Salvare in Bitwarden una nota "Padel TOPFLY - Produzione" con:

- URL produzione;
- AWS account/istanza/regione/static IP;
- path server `/opt/padel-topfly`;
- contenuto `.env.production`;
- dati Microsoft Entra;
- dati Microsoft Graph;
- mailbox `padel@topflysolutions.com`;
- deploy key GitHub Actions dedicata;
- known hosts GitHub Actions;
- repository variable `PRODUCTION_AUTO_DEPLOY=true`;
- ultima data di backup DB manuale.

Non salvare segreti in Git e non incollarli in chat.

## Microsoft Graph

Permessi Graph sull'app registration:

- `Calendars.ReadWrite` Application;
- `Mail.Send` Application;
- consenso amministratore concesso.

`Mail.Send` serve solo per inviare i PDF degli scarichi responsabilita' alla mailbox
condivisa configurata in `APP_WAIVER_RECIPIENT_EMAIL`. In produzione il valore atteso e'
`padel@topflysolutions.com`, non una casella personale. Le prenotazioni nascono
`PENDING_SIGNATURES`; la conferma del referente usa l'invito/evento Outlook solo quando
tutte le firme attive arrivano a `playerCount/playerCount`. Gli ospiti gia' firmatari
ricevono invece una mail custom se la prenotazione viene modificata o cancellata.

La conferma a firme complete crea un evento Outlook con invito e reminder 1h.
La cancellazione del referente usa solo `event/cancel`, cosi' Gmail/Google Calendar non
riceve un update duplicato prima del cancel. Gli ospiti gia' firmatari vengono avvisati via
`sendMail`.
La mail automatica con prefisso `Canceled:` e' generata da Outlook: l'app controlla solo
il commento testuale, che deve restare breve e chiaro.

Le pending incomplete vengono processate da `.github/workflows/signature-deadlines.yml`
tramite `POST /api/internal/signature-deadlines` protetto da `APP_INTERNAL_CRON_SECRET`.
Il secret deve essere presente nei GitHub Actions secrets; `Deploy Production` lo sincronizza in
`.env.production` sul server prima del recreate dei container.
L'app esegue anche pulizia opportunistica su disponibilita', lookup e firma ospiti.

Hardening Microsoft 365 raccomandato:

- limitare `Calendars.ReadWrite` e `Mail.Send` Application alla sola mailbox
  `padel@topflysolutions.com` con Exchange Application Access Policy o RBAC for
  Applications;
- verificare che la mailbox sia tecnica/condivisa e non usata come account personale.
- gli utenti che devono leggere gli scarichi possono avere `FullAccess` alla shared mailbox;
- non serve `SendAs` se non devono inviare manualmente email come Padel.
