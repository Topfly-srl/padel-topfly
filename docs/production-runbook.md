# Stato Produzione E Checklist

Documento di stato per Padel TOPFLY aggiornato dopo il primo deploy AWS.

## Produzione Attiva

URL:

- <https://padel.topflysolutions.com>

## Stato Modifiche

- **Locale**: modifiche nel working tree Codex/Mac. Non sono in produzione finche' non
  vengono committate e pushate su GitHub.
- **GitHub**: modifiche presenti su `main`. Con `PRODUCTION_AUTO_DEPLOY=true`, il push su
  `main` avvia il workflow `Deploy Production`.
- **Produzione**: considerare una modifica effettivamente attiva solo dopo workflow verde e
  smoke test su <https://padel.topflysolutions.com>.

Risorse:

- GitHub repo: `Topfly-srl/padel-topfly`.
- AWS Lightsail instance: `padel-topfly`.
- Static IP: `18.194.7.194`.
- DNS: `padel.topflysolutions.com`.
- Server path: `/opt/padel-topfly`.
- Runtime: Docker Compose.
- Database: Postgres locale in Docker.
- Reverse proxy: Caddy.
- Certificato HTTPS: Let's Encrypt via Caddy.

## Cosa E' Gia' Fatto

Nota: i punti relativi agli ultimi fix hardening descrivono lo stato del repo aggiornato.
Una modifica e' produzione solo dopo push su `main`, workflow verde e smoke test.

- App Next.js deployata in produzione.
- Repo GitHub pubblica.
- AWS Lightsail creata e configurata.
- Static IP associato.
- DNS aziendale configurato via cPanel/Serverplan.
- HTTPS attivo con redirect automatico da HTTP.
- Security headers configurati in Next e Caddy.
- Header `X-Powered-By` Next disattivato e rimosso da Caddy.
- Postgres locale persistente su volume Docker.
- Migrazioni Prisma eseguite automaticamente all'avvio app.
- Login pubblico eliminato per gli utenti normali.
- Prenotazione pubblica con nome/cognome + email.
- "Le mie prenotazioni" basata su token salvati nel browser.
- Modifica/cancellazione prenotazione tramite token.
- Area `/admin` protetta da Microsoft Entra ID.
- Admin abilitato: `antony.buffone@topflysolutions.com`.
- UX desktop sistemata: sidebar riepilogo + prenotazioni sticky insieme.
- UI brandizzata TOPFLY con palette rossa aziendale.
- Microsoft Graph/Outlook configurato.
- Mailbox/calendario dedicato `padel@topflysolutions.com` attivo.
- Inviti Outlook automatici attivi.
- Reminder Outlook 1h attivo.
- Workflow GitHub Actions `Deploy Production` configurato, testato e attivo con CI prima del deploy.
- Autodeploy attivo a ogni push su `main` tramite repository variable `PRODUCTION_AUTO_DEPLOY=true`.
- Backup pre-deploy salvato fuori repo in `/var/backups/padel-topfly`.
- Container `app` hardenizzato con utente non-root, `no-new-privileges` e capabilities rimosse.
- API sensibili con `Cache-Control: no-store`.
- Controllo Origin/Referer attivo sulle mutazioni in produzione.
- Rate limit attivo per IP e per email globale su creazione prenotazione.
- Audit log sanificato da token/hash e dettagli tecnici Graph.
- Cancellazione Outlook ritentabile se una cancellazione precedente fallisce.
- Avvio produzione fail-fast se mancano env critiche.
- Checklist Bitwarden creata in `docs/bitwarden-checklist.md`.
- Istruzioni operative per Codex/agenti create in `AGENTS.md`.
- Report security audit creato in `docs/security-audit.md`.

## Cosa Non E' Ancora Fatto

- Backup automatici non ancora configurati.
- Monitoraggio/alerting non ancora configurato.
- Rimozione del permesso Graph `Mail.Send` da Entra, se ancora presente dopo gli ultimi smoke test.
- Limitazione del permesso Graph Application alla sola mailbox Padel tramite Exchange
  Application Access Policy/RBAC, da verificare manualmente.
- Branch protection su `main` da valutare/abilitare.
- Eventuale pagina/documento interno per annunciare il link ai dipendenti.

## Test Da Fare Prima Di Annunciare In Azienda

Da browser normale:

1. Aprire <https://padel.topflysolutions.com>.
2. Creare una prenotazione con nome e email aziendale.
3. Verificare che lo slot risulti occupato con solo nome visibile.
4. Verificare "Le mie prenotazioni".
5. Modificare la prenotazione.
6. Cancellare la prenotazione e verificare la mail `Canceled:` nativa Outlook.
7. Creare due prenotazioni future con la stessa email.
8. Tentare una terza prenotazione futura con la stessa email e verificare il blocco.

Da admin:

1. Aprire <https://padel.topflysolutions.com/admin>.
2. Fare login Microsoft con account admin.
3. Creare un blocco campo.
4. Verificare che un utente non possa prenotare su quello slot.
5. Rimuovere il blocco.
6. Controllare storico/audit.

Da terminale locale:

```bash
curl -I https://padel.topflysolutions.com
curl -I http://padel.topflysolutions.com
```

Atteso:

- HTTPS: `HTTP/2 200`.
- HTTP: `308 Permanent Redirect`.
- Header attesi su HTTPS:
  - `content-security-policy`;
  - `x-content-type-options: nosniff`;
  - `x-frame-options: DENY`;
  - `referrer-policy: strict-origin-when-cross-origin`;
  - assenza di `x-powered-by`.

## Procedura Aggiornamento Codice

Locale:

```bash
npm run lint
npm test
npm run build
git status --short
```

Dopo commit/push su `main`, GitHub Actions deploya automaticamente su Lightsail tramite
workflow `Deploy Production`, se la repository variable `PRODUCTION_AUTO_DEPLOY=true`
resta attiva.

### Setup Una Tantum Autodeploy

Il setup e' gia' stato completato in GitHub. Questa procedura resta qui per rotazione
chiavi, ripristino o nuova configurazione.

Il deploy automatico usa una chiave SSH dedicata salvata nei GitHub Actions secrets. Non
usare la chiave personale Lightsail se puoi evitarlo.

Da una sessione SSH su Lightsail:

```bash
ssh-keygen -t ed25519 -f /tmp/padel-github-actions -C "github-actions-padel-topfly" -N ""
mkdir -p ~/.ssh
cat /tmp/padel-github-actions.pub >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
cat /tmp/padel-github-actions
rm /tmp/padel-github-actions /tmp/padel-github-actions.pub
```

Copia il blocco privato stampato da `cat /tmp/padel-github-actions` in GitHub:

- repo `Topfly-srl/padel-topfly`;
- `Settings`;
- `Secrets and variables`;
- `Actions`;
- `New repository secret`;
- nome `LIGHTSAIL_SSH_PRIVATE_KEY`.

Non incollare questa chiave in chat. Salvala anche in Bitwarden come nota segreta.

Sempre in GitHub Actions secrets aggiungi:

```txt
LIGHTSAIL_HOST=18.194.7.194
LIGHTSAIL_USER=ubuntu
```

Per il known host, da terminale locale o da Lightsail:

```bash
ssh-keyscan -H 18.194.7.194
```

Copia tutto l'output in un repository secret:

```txt
LIGHTSAIL_KNOWN_HOSTS=<output ssh-keyscan>
```

Per abilitare il deploy automatico a ogni push su `main`, aggiungi una repository variable:

```txt
PRODUCTION_AUTO_DEPLOY=true
```

Senza questa variabile, il workflow resta disponibile solo dal pulsante manuale
`Run workflow`. Questa protezione evita deploy automatici se in futuro si vogliono
congelare i deploy da `main`.

### Cosa Fa Il Workflow

1. esegue CI (`npm run lint`, `npm test`, `npm run build`, `npx prisma validate`,
   `npm audit --omit=dev`);
2. valida che i secrets SSH siano presenti;
3. entra su Lightsail via SSH;
4. crea un dump Postgres in `/var/backups/padel-topfly` se il container Postgres e'
   gia' disponibile; altrimenti segnala il backup skipped;
5. esegue `git pull --ff-only origin main`;
6. ricostruisce Docker Compose;
7. riavvia Caddy per ricaricare eventuali modifiche al proxy/header;
8. esegue health check su <https://padel.topflysolutions.com>.

### Fallback Manuale

Se GitHub Actions non e' configurato o fallisce, server:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 -o "$(whoami)" -g "$(id -gn)" "$BACKUP_DIR"
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly \
  > "$BACKUP_DIR/padel_topfly_$(date +%Y%m%d-%H%M%S).sql" < /dev/null
git pull --ff-only origin main
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml restart caddy
sudo docker compose -f docker-compose.production.yml ps
```

Verifica:

```bash
sudo docker compose -f docker-compose.production.yml logs -f app
curl -I https://padel.topflysolutions.com
```

## Procedura Aggiornamento Env

Prima backup:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 "$BACKUP_DIR"
sudo cp .env.production "$BACKUP_DIR/.env.production.backup.$(date +%Y%m%d-%H%M%S)"
sudo nano .env.production
```

Se cambiano solo env app:

```bash
sudo docker compose -f docker-compose.production.yml up -d --force-recreate app
sudo docker compose -f docker-compose.production.yml ps
```

Se cambia dominio/Caddy:

```bash
sudo docker compose -f docker-compose.production.yml up -d
sudo docker compose -f docker-compose.production.yml logs -f caddy
```

## Backup E Conservazione Credenziali

Checklist dettagliata: [`docs/bitwarden-checklist.md`](bitwarden-checklist.md).

Da salvare in Bitwarden:

- `.env.production` completo.
- `AUTH_SECRET`.
- `POSTGRES_PASSWORD`.
- Microsoft Entra client ID, tenant ID e client secret.
- Static IP e dati server.
- Microsoft Graph tenant ID, client ID e client secret.
- Mailbox Graph: `padel@topflysolutions.com`.
- GitHub Actions deploy key dedicata.
- GitHub Actions known hosts.
- Repository variable `PRODUCTION_AUTO_DEPLOY=true`.

Da non salvare in Git:

- `.env.production`.
- backup `.env.production.backup.*`, anche se salvati fuori repo.
- chiavi SSH.
- client secret Microsoft.

## Costi

Configurazione volutamente minimale:

- una sola istanza Lightsail;
- database locale su Docker;
- niente database gestito;
- niente load balancer;
- niente CDN;
- niente snapshot automatici per ora.

Costo atteso dopo eventuale periodo gratuito: circa il costo mensile del piano Lightsail scelto.

## Prossimi Passi Consigliati

1. Salvare/aggiornare tutti gli item indicati in `docs/bitwarden-checklist.md`.
2. Fare smoke test completo con 2-3 colleghi.
3. Verificare mail conferma e mail cancellazione Outlook dopo ogni patch Graph.
4. Rimuovere `Mail.Send` da Entra se ancora presente.
5. Limitare `Calendars.ReadWrite` alla mailbox `padel@topflysolutions.com`.
6. Valutare snapshot manuale o backup database schedulato.
7. Preparare messaggio interno con link e regole d'uso.

## Microsoft Graph

App registration: `Padel TOPFLY Admin`.

Permessi Graph richiesti:

- `Calendars.ReadWrite` Application, consenso admin concesso.

`Mail.Send` non e' richiesto dalla V1: l'app usa gli inviti/eventi Outlook per conferme,
modifiche e cancellazioni, senza inviare una seconda email custom separata.
Se `Mail.Send` e' ancora presente tra i permessi Entra, puo' essere rimosso dopo smoke
test positivo di creazione, modifica e cancellazione prenotazione.

La mailbox usata dall'app e':

```txt
padel@topflysolutions.com
```

Conferme:

- creano evento Outlook nel calendario `padel@topflysolutions.com`;
- invitano l'email inserita nel form;
- includono reminder Outlook 1 ora prima;
- includono link di gestione.

Cancellazioni:

- aggiornano l'evento con contenuto di cancellazione;
- cancellano l'evento Outlook tramite Graph `event/cancel`;
- se l'aggiornamento accessorio dell'evento fallisce, la cancellazione calendario resta
  valida e il warning viene salvato in `outlookSyncError`.

Verifica Graph da server senza stampare segreti:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml exec -T app node - <<'JS'
(async () => {
  const body = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }
  );
  const tokenJson = await tokenRes.json();
  console.log("TOKEN_STATUS:", tokenRes.status);
  if (!tokenRes.ok) return;

  const mailbox = process.env.MS_GRAPH_MAILBOX;
  const calendarRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendar`,
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } }
  );
  console.log("MAILBOX:", mailbox);
  console.log("CALENDAR_STATUS:", calendarRes.status);
})();
JS
```

## Backup Database

Prima di un deploy importante creare un dump Postgres:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 -o "$(whoami)" -g "$(id -gn)" "$BACKUP_DIR"
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly > "$BACKUP_DIR/padel_topfly_$(date +%Y%m%d-%H%M%S).sql"
ls -lh "$BACKUP_DIR" | tail
```

Non usare `docker compose down -v` in produzione: elimina il volume Postgres.

## Comandi Di Emergenza

Riavvio app:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml restart app
```

Riavvio completo stack:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml restart
```

Fermare stack:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml down
```

Attenzione: `down` non elimina i volumi se non si usa `-v`, quindi il DB resta. Non usare `-v` in produzione.
