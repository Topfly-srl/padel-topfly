# Padel TOPFLY

Web app interna mobile-first per prenotare il campo da padel aziendale.

URL produzione:

- <https://padel.topflysolutions.com>

## Stato Produzione

- Hosting: AWS Lightsail, istanza `padel-topfly`, regione Frankfurt `eu-central-1`.
- Static IP: `18.194.7.194`.
- DNS: record `A` `padel.topflysolutions.com -> 18.194.7.194` gestito da cPanel/Serverplan.
- HTTPS: gestito automaticamente da Caddy con certificato Let's Encrypt.
- Database: Postgres locale in Docker, volume `padel_topfly_pgdata`.
- Login utenti: nessun login, prenotazione pubblica con nome/cognome + email.
- Login admin: Microsoft Entra ID attivo su `/admin`.
- Outlook/Graph: attivo in produzione con mailbox `padel@topflysolutions.com`.

## Funzionalita'

- Prenotazione pubblica senza login utente.
- Form obbligatorio con nome/cognome ed email.
- Email non aziendali ammesse, con warning non bloccante lato UI.
- Nome del prenotante visibile sugli slot occupati, email mai esposta pubblicamente.
- Link/token di gestione salvato localmente e incluso negli inviti Outlook.
- Modifica/cancellazione delle proprie prenotazioni tramite token.
- Area admin protetta da Microsoft 365 per blocchi, storico e override.
- Limiti applicativi:
  - step slot: 15 minuti;
  - durata: 15-120 minuti;
  - anticipo massimo: 14 giorni;
  - massimo 2 prenotazioni future per email.

## Stack

- Next.js App Router + TypeScript.
- Prisma + Postgres.
- Auth.js / NextAuth con Microsoft Entra ID solo per area admin.
- Microsoft Graph per inviti Outlook, promemoria e avvisi di cancellazione.
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
npx prisma validate
```

## Produzione AWS

La produzione vive su Lightsail in:

```txt
/opt/padel-topfly
```

Deploy manuale sul server:

```bash
cd /opt/padel-topfly
mkdir -p backups
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly > backups/padel_topfly_$(date +%Y%m%d-%H%M%S).sql
git pull origin main
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
sudo cp .env.production .env.production.backup.$(date +%Y%m%d-%H%M%S)
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

Permessi Microsoft Graph richiesti sull'app registration:

- `Calendars.ReadWrite` Application, con consenso amministratore;
- `Mail.Send` Application, con consenso amministratore.

Funzioni attese:

- creare evento Outlook per ogni prenotazione;
- inviare invito all'email inserita nel form;
- includere reminder 1h;
- includere link gestione nel corpo evento;
- aggiornare evento quando cambia la prenotazione;
- cancellare evento Outlook quando la prenotazione viene annullata;
- inviare una mail HTML brandizzata quando la prenotazione viene annullata.

Verifica rapida da server:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml logs app --tail=120
```

Se una prenotazione resta con stato Outlook `FAILED`, controllare `outlookSyncError` nel DB o nei log app.

## Documentazione Operativa

- Runbook AWS/Lightsail: [`docs/aws-deploy.md`](docs/aws-deploy.md)
- Stato produzione e checklist: [`docs/production-runbook.md`](docs/production-runbook.md)
