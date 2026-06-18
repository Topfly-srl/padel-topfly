# Padel TOPFLY

Web app interna mobile-first per prenotare il campo da padel aziendale.

URL produzione:

- <https://padel.topflysolutions.com>

## Ambiente Test / Preview

Per pubblicare una versione solo test, usare `APP_ENV=preview` sotto il path
dedicato `/test` del dominio gia' attivo:

```env
APP_ENV=preview
APP_BASE_PATH=/test
APP_PUBLIC_ORIGIN=https://padel.topflysolutions.com/test
NEXT_PUBLIC_APP_BASE_PATH=/test
```

In modalita' preview l'app mostra il badge `TEST`, gli inviti Outlook e le email PDF
hanno oggetto con prefisso `[TEST]`, il corpo email contiene un avviso `AMBIENTE TEST`
e i link di gestione/firma ospiti includono `test=1`.

## Stato Produzione

- Hosting: AWS Lightsail, istanza `padel-topfly`, regione Frankfurt `eu-central-1`.
- Static IP: `18.194.7.194`.
- DNS: record `A` `padel.topflysolutions.com -> 18.194.7.194` gestito da cPanel/Serverplan.
- HTTPS: gestito automaticamente da Caddy con certificato Let's Encrypt.
- Security headers: configurati in Next e Caddy; verificare dopo ogni deploy con
  `curl -I`. `X-Powered-By` e' disattivato da Next e rimosso da Caddy.
- Database: Postgres locale in Docker, volume `padel_topfly_pgdata`.
- Login utenti: nessun login, prenotazione pubblica con nome/cognome + email.
- Login admin: Microsoft Entra ID attivo su `/admin`.
- Outlook/Graph: attivo in produzione con mailbox `padel@topflysolutions.com`.
- Deploy: GitHub Actions autodeploy attivo su push `main`.
- Security audit: [`docs/security-audit.md`](docs/security-audit.md).

## Funzionalita'

- Prenotazione pubblica senza login utente.
- Form obbligatorio con nome/cognome ed email.
- Scarico responsabilita' digitale obbligatorio per il referente al momento della prenotazione.
- Link firma ospiti separato, mostrato dopo la prenotazione e copiabile anche manualmente.
- PDF firmato archiviato in Postgres e inviato a `cecilia.faieta@topflysolutions.com`.
- Email non aziendali ammesse, con warning non bloccante lato UI.
- Nome del prenotante visibile sugli slot occupati, email mai esposta pubblicamente.
- Link/token di gestione salvato localmente e incluso negli inviti Outlook.
- Modifica/cancellazione delle proprie prenotazioni tramite token.
- Area admin protetta da Microsoft 365 per blocchi, storico e override.
- Area admin con conteggio firme, stato invio PDF e retry email per scarichi falliti.
- Limiti applicativi:
  - step slot: 15 minuti;
  - durata: 15-120 minuti;
  - anticipo massimo: 14 giorni;
  - massimo 2 prenotazioni future per email.

## Stack

- Next.js App Router + TypeScript.
- Prisma + Postgres.
- Auth.js / NextAuth con Microsoft Entra ID solo per area admin.
- Microsoft Graph per inviti Outlook, promemoria, cancellazioni native Outlook e invio PDF waiver.
- Docker Compose in produzione:
  - `app`: Next.js;
  - `postgres`: database locale;
  - `caddy`: reverse proxy HTTPS.

## Setup Locale

1. Copia `.env.example` in `.env.local` e configura almeno `DATABASE_URL`.
2. Per sviluppo admin senza Microsoft 365, lascia `AUTH_DEV_MODE="true"`.
3. Genera Prisma:

```bash
npm run prisma:generate
```

4. Esegui le migrazioni:

```bash
npm run prisma:migrate
```

5. Avvia l'app:

```bash
npm run dev
```

Comandi di verifica:

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
```

### Pulizia Locale

La cartella locale puo' pesare oltre 1 GB anche se il sito e' piccolo: quasi tutto lo
spazio e' occupato da `node_modules` e `.next`, che non finiscono in GitHub ne' nel build
context Docker.

Per pulire build/cache locali senza toccare le dipendenze:

```bash
npm run clean
```

Per liberare piu' spazio rimuovendo anche `node_modules`:

```bash
npm run clean:full
npm ci
```

## Produzione AWS

La produzione vive su Lightsail in:

```txt
/opt/padel-topfly
```

Deploy consigliato:

- push su `main`;
- GitHub Actions workflow `Deploy Production`;
- autodeploy attivo con repository variable `PRODUCTION_AUTO_DEPLOY=true` e secrets SSH
  Lightsail configurati.

Il workflow esegue prima CI (`lint`, test, build, Prisma validate e audit npm), forza le
JavaScript Actions sul runtime Node 24, crea un backup Postgres fuori dal repo in
`/var/backups/padel-topfly` quando Postgres e' gia' attivo, aggiorna `/opt/padel-topfly`,
ricostruisce Docker Compose ed esegue health check su <https://padel.topflysolutions.com>
e su un'API pubblica con `Cache-Control: no-store`.

La produzione usa hardening Docker per il container `app`: utente non-root,
`no-new-privileges` e capabilities Linux rimosse.

Setup dettagliato: [`docs/production-runbook.md`](docs/production-runbook.md).

Fallback manuale sul server:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 -o "$(whoami)" -g "$(id -gn)" "$BACKUP_DIR"
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly \
  > "$BACKUP_DIR/padel_topfly_$(date +%Y%m%d-%H%M%S).sql" < /dev/null
git pull --ff-only origin main
sudo docker compose -f docker-compose.production.yml up -d --build
sudo docker compose -f docker-compose.production.yml ps
```

Log utili:

```bash
sudo docker compose -f docker-compose.production.yml logs -f app
sudo docker compose -f docker-compose.production.yml logs -f caddy
sudo docker compose -f docker-compose.production.yml logs -f postgres
```

Health check esterno:

```bash
curl -I https://padel.topflysolutions.com
curl -I http://padel.topflysolutions.com
```

Atteso:

- HTTPS: `HTTP/2 200`.
- HTTP: redirect `308` verso HTTPS.

Prima di modificare `.env.production`, creare sempre un backup:

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 "$BACKUP_DIR"
sudo cp .env.production "$BACKUP_DIR/.env.production.backup.$(date +%Y%m%d-%H%M%S)"
sudo nano .env.production
```

Non committare mai `.env.production`.

## Variabili Produzione

Valori gia' attesi in produzione:

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

POSTGRES_USER=padel
POSTGRES_DB=padel_topfly
DATABASE_URL=postgresql://padel:...@postgres:5432/padel_topfly?schema=public
```

Segreti da conservare in Bitwarden, mai in chat o Git:

- `AUTH_SECRET`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `MICROSOFT_ENTRA_ID_SECRET`
- `MS_GRAPH_CLIENT_SECRET`
- tenant/client ID Microsoft Entra e Graph

Checklist completa: [`docs/bitwarden-checklist.md`](docs/bitwarden-checklist.md).

## Microsoft Entra Admin

L'area admin e' disponibile su:

- <https://padel.topflysolutions.com/admin>

App registration Entra:

- nome: `Padel TOPFLY Admin`;
- account type: tenant singolo TOPFLY;
- redirect URI:

```txt
https://padel.topflysolutions.com/api/auth/callback/microsoft-entra-id
```

Env richieste:

```env
MICROSOFT_ENTRA_ID_ID=
MICROSOFT_ENTRA_ID_SECRET=
MICROSOFT_ENTRA_ID_TENANT_ID=
```

Solo le email in `APP_ADMIN_EMAILS` ricevono ruolo `ADMIN`.

## Microsoft Graph Outlook

Graph e' attivo in produzione con mailbox dedicata:

```env
MS_GRAPH_TENANT_ID=...
MS_GRAPH_CLIENT_ID=...
MS_GRAPH_CLIENT_SECRET=...
MS_GRAPH_MAILBOX=padel@topflysolutions.com
```

Permessi Microsoft Graph sull'app registration:

- `Calendars.ReadWrite` Application, con consenso amministratore.
- `Mail.Send` Application, con consenso amministratore, per inviare a Cecilia i PDF firmati.

`Mail.Send` e' richiesto solo per lo scarico responsabilita' digitale. La conferma e la
cancellazione della prenotazione continuano a passare dagli inviti/eventi Outlook,
evitando una seconda email custom quando l'utente cancella.

Per ridurre il blast radius dei permessi Application, limitare `Calendars.ReadWrite` e
`Mail.Send` alla sola mailbox `padel@topflysolutions.com` tramite Exchange Application
Access Policy o RBAC for Applications.

Stato operativo da verificare manualmente in Microsoft 365:

- `Calendars.ReadWrite` Application con admin consent;
- `Mail.Send` Application con admin consent;
- policy Exchange/RBAC limitata alla mailbox `padel@topflysolutions.com`.

Funzioni attese:

- creare evento Outlook per ogni prenotazione;
- inviare invito all'email inserita nel form;
- includere reminder 1h;
- includere link gestione nel corpo evento;
- includere link firma ospiti nel corpo evento quando disponibile;
- aggiornare evento quando cambia la prenotazione;
- cancellare evento Outlook quando la prenotazione viene annullata;
- inviare a Cecilia il PDF dello scarico responsabilita' firmato.

Verifica rapida da server:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml logs app --tail=120
```

Se una prenotazione resta con stato Outlook `FAILED`, controllare `outlookSyncError` nel DB o nei log app.
Se invece `outlookSyncStatus` e' `SYNCED` ma `outlookSyncError` contiene un warning,
la cancellazione calendario e' riuscita ma un aggiornamento accessorio dell'evento non e'
andato a buon fine.

## Documentazione Operativa

- Runbook AWS/Lightsail: [`docs/aws-deploy.md`](docs/aws-deploy.md)
- Stato produzione e checklist: [`docs/production-runbook.md`](docs/production-runbook.md)
- Security audit: [`docs/security-audit.md`](docs/security-audit.md)
- Checklist Bitwarden: [`docs/bitwarden-checklist.md`](docs/bitwarden-checklist.md)
- Istruzioni agenti/Codex: [`AGENTS.md`](AGENTS.md)
