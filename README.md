# Padel TOPFLY

Web app interna mobile-first per prenotare il campo da padel aziendale.

URL produzione:

- <https://padel.topflysolutions.com>

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
- Deploy: GitHub Actions `Deploy Production`; con `PRODUCTION_AUTO_DEPLOY=false` il push su
  `main` esegue CI e il deploy va lanciato manualmente da Actions.
- Security audit: [`docs/security-audit.md`](docs/security-audit.md).

## Funzionalita'

- Prenotazione pubblica senza login utente.
- Form obbligatorio con nome/cognome ed email.
- Scarico responsabilita' digitale obbligatorio per il referente al momento della prenotazione.
- Le nuove prenotazioni restano `PENDING_SIGNATURES` finche' le firme attive non arrivano a
  `playerCount/playerCount`; solo allora diventano `CONFIRMED`.
- Link firma ospiti separato, mostrato dopo la prenotazione e copiabile anche manualmente.
- Prenotazioni pending incomplete: reminder al referente prima della scadenza e annullamento
  automatico se mancano firme.
- Firma col dito acquisita come firma elettronica semplice, con hash e audit tecnico.
- PDF firmato archiviato in Postgres e inviato alla mailbox condivisa configurata in
  `APP_WAIVER_RECIPIENT_EMAIL`.
- Email non aziendali ammesse, con warning non bloccante lato UI.
- Nome del prenotante visibile sugli slot occupati, email mai esposta pubblicamente.
- Link/token di gestione salvato localmente e inviato nella mail provvisoria al referente.
- Modifica/cancellazione delle proprie prenotazioni tramite token.
- Area admin protetta da Microsoft 365 per blocchi, storico e override.
- Area admin con conteggio firme, stato invio PDF e retry email per scarichi falliti.
- Limiti applicativi:
  - step slot: 15 minuti;
  - durata: 15-120 minuti;
  - fascia di apertura: giornata piena 00:00-24:00 di default (ultimo slot 23:45, la partita deve terminare entro la mezzanotte; fascia riducibile via `APP_OPENING_HOUR` / `APP_CLOSING_HOUR`);
  - anticipo massimo: 14 giorni;
  - massimo 2 prenotazioni future per email.

## Stack

- Next.js App Router + TypeScript.
- Prisma + Postgres.
- Auth.js / NextAuth con Microsoft Entra ID solo per area admin.
- Microsoft Graph per inviti Outlook, promemoria, cancellazioni native Outlook, invio PDF waiver
  e notifiche ospiti con allegati calendario quando servono.
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

`npm test` gira il progetto `unit` (demo in-memory, senza DB). I test di integrazione girano contro
un Postgres vero:

```bash
npm run test:integration
```

### Test Di Parita' Demo/Prod

I flussi di prenotazione hanno due implementazioni gemelle: i service Prisma (con `DATABASE_URL`) e il
demo in-memory (`src/lib/demo-store.ts`, usato senza DB e da tutti i test unit). Per evitare che i due
gemelli divergano in silenzio, gli scenari condivisi in `src/lib/parity/scenarios.ts` girano sia sul
demo (progetto `unit`) sia sui service su Postgres (progetto `integration`) e asseriscono gli stessi
esiti. Prima di cambiare un comportamento di prenotazione, aggiornalo su entrambi i gemelli e/o
sull'attesa condivisa: chi non si allinea diventa rosso subito. Dettagli e procedura per aggiungere un
flusso nuovo in `AGENTS.md`, sezione "Parita' Demo/Prod".

### Anteprima Email

`npm run preview:emails` rende con dati finti tutte le email di `src/lib/graph.ts` in
`output/anteprima-email.html` (`-- --out percorso.html` per cambiare file): non invia niente,
intercetta le chiamate a Graph e mostra oggetto, destinatario e preheader di ogni messaggio.

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
- secrets SSH Lightsail configurati;
- al momento `PRODUCTION_AUTO_DEPLOY=false`, quindi dopo il push va controllata la run e,
  se il job deploy e' skipped, va lanciato manualmente `Deploy Production`.

Il workflow esegue prima CI (`lint`, test, build, Prisma validate e audit npm), forza le
JavaScript Actions sul runtime Node 24, crea un backup Postgres fuori dal repo in
`/var/backups/padel-topfly` quando Postgres e' gia' attivo, aggiorna `/opt/padel-topfly`,
ricostruisce Docker Compose ed esegue health check su <https://padel.topflysolutions.com>
e su un'API pubblica con `Cache-Control: no-store`.

La produzione usa hardening Docker per il container `app`: utente non-root,
`no-new-privileges` e capabilities Linux rimosse.

### Checklist "Manda Tutto Online"

Quando si vuole pubblicare sul sito ufficiale, la procedura completa e':

```bash
npm run lint
npm test
npm run build
DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
npm audit --omit=dev
git status --short --branch
```

Poi:

1. commit descrittivo;
2. push su `main`;
3. controllare la run `Deploy Production` su GitHub Actions;
4. se il job deploy e' skipped per `PRODUCTION_AUTO_DEPLOY` spento, lanciare
   `gh workflow run "Deploy Production" --ref main`;
5. attendere la run fino a conclusione verde;
6. verificare <https://padel.topflysolutions.com> e `/api/availability`;
7. lanciare manualmente `Signature Deadlines` e verificare che risponda
   `{"ok":true,...}`;
8. verificare che l'endpoint cron senza token risponda `401 Non autorizzato`.

Una run schedulata di `Signature Deadlines` puo' fallire con `503` mentre il deploy sta
ricreando i container. Dopo un deploy verde va sempre rilanciata una run manuale del workflow:
se passa, il cron e il secret sono allineati.

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

Valori gia' attesi in produzione. La modalita' produzione si attiva con `APP_ENV=production`
**oppure** automaticamente quando il container gira con `next start` (`NODE_ENV=production`):
in quel caso l'app fa fail-fast all'avvio se mancano le env critiche (DB, Entra, Graph), per
evitare di girare in modalita' "development" con auth e header di sicurezza degradati.

```env
APP_DOMAIN=padel.topflysolutions.com
APP_ENV=production
APP_PUBLIC_ORIGIN=https://padel.topflysolutions.com
APP_ALLOWED_DOMAIN=topflysolutions.com
APP_ADMIN_EMAILS=antony.buffone@topflysolutions.com
APP_TIME_ZONE=Europe/Rome
# Facoltative: di default il campo e' prenotabile tutto il giorno (00-24).
# APP_OPENING_HOUR=8
# APP_CLOSING_HOUR=22
APP_INTERNAL_CRON_SECRET=...

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
- `APP_INTERNAL_CRON_SECRET`
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
APP_WAIVER_RECIPIENT_EMAIL=padel@topflysolutions.com
```

Permessi Microsoft Graph sull'app registration:

- `Calendars.ReadWrite` Application, con consenso amministratore.
- `Mail.Send` Application, con consenso amministratore, per inviare i PDF firmati alla
  mailbox condivisa Padel.

`Mail.Send` e' richiesto per lo scarico responsabilita' digitale e per le email agli
ospiti che hanno firmato. La conferma, modifica e cancellazione del referente continuano a
passare dagli inviti/eventi Outlook, evitando una seconda email custom all'organizzatore.

Per ridurre il blast radius dei permessi Application, limitare `Calendars.ReadWrite` e
`Mail.Send` alla sola mailbox `padel@topflysolutions.com` tramite Exchange Application
Access Policy o RBAC for Applications.

Stato operativo da verificare manualmente in Microsoft 365:

- `Calendars.ReadWrite` Application con admin consent;
- `Mail.Send` Application con admin consent;
- policy Exchange/RBAC limitata alla mailbox `padel@topflysolutions.com`.

Funzioni attese:

- creare evento Outlook solo quando la prenotazione passa a `CONFIRMED`;
- inviare invito all'email inserita nel form solo a firme complete;
- includere reminder 1h;
- inviare al referente una mail provvisoria con link gestione, link firma ospiti e scadenza firme;
- inviare reminder al referente quando la prenotazione pending si avvicina alla scadenza;
- inviare annullamento automatico al referente quando una pending scade incompleta;
- aggiornare/cancellare l'evento quando una prenotazione confermata cambia stato;
- cancellare evento Outlook quando la prenotazione viene annullata;
- ritirare l'evento con un commento differenziato quando una prenotazione confermata perde una
  firma e torna in attesa (motivo "firme mancanti", non una cancellazione definitiva);
- inviare il PDF dello scarico responsabilita' firmato alla mailbox condivisa configurata.
- inviare agli ospiti gia' firmatari una notifica se la prenotazione viene modificata o
  cancellata; la mail di modifica include la nuova scadenza firme;
- avvisare il referente con una mail dedicata quando ad annullare e' un admin diverso dal
  referente, senza esporre chi ha annullato.

Mailbox scarichi:

- mailbox consigliata: `padel@topflysolutions.com`;
- `MS_GRAPH_MAILBOX` e `APP_WAIVER_RECIPIENT_EMAIL` possono coincidere: l'app invia il PDF
  dalla mailbox Padel alla stessa mailbox Padel, cosi' lo scarico resta archiviato senza
  intasare una casella personale;
- chi deve consultare gli scarichi puo' ricevere solo `FullAccess` alla shared mailbox;
- non serve concedere `SendAs` agli utenti se devono solo leggere/gestire i PDF ricevuti.

Privacy e conservazione:

- il database conserva PDF firmati, immagine firma, dati anagrafici, email e hash tecnici;
- la policy di conservazione definitiva va confermata da TOPFLY prima del go-live pieno;
- fino a decisione formale, evitare export non necessari e prenotazioni di prova non concordate.

Verifica rapida da server:

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.production.yml logs app --tail=120
```

Se una prenotazione resta con stato Outlook `FAILED`, controllare `outlookSyncError` nel DB o nei log app.

### Esecuzione differita (email e Outlook)

Per non far attendere l'utente sulla latenza di Microsoft Graph, l'invio email e il sync
Outlook vengono eseguiti **dopo** che la risposta e' stata inviata, tramite l'helper
`src/lib/after-response.ts` (basato su `after()` di Next.js). La prenotazione e la firma
vengono salvate in modo transazionale **prima** della risposta, quindi stato e conteggi firme
sono immediati e accurati; gli step accessori partono subito dopo, dietro le quinte, e registrano comunque il
proprio esito (`emailStatus`, `outlookSyncStatus`) per visibilita' e retry dall'area admin.
Affidabile sul runtime a container long-running in produzione (`next start`).

### Scadenze firme

Le prenotazioni pending bloccano lo slot finche' non scadono. La finestra per raccogliere le
firme e' meta' del tempo che manca all'inizio, con un minimo di 24 ore e un tetto di 4 giorni:
chi prenota con largo anticipo non deve raccogliere le firme entro il giorno dopo, ma una
pending mai firmata non tiene lo slot bloccato per una settimana. La deadline firme e':

- prima tra meta' del tempo mancante (minimo 24 ore, massimo 4 giorni) dalla creazione e 4 ore
  prima dell'inizio;
- per prenotazioni sotto le 4 ore dall'inizio: prima tra 30 minuti dalla creazione e l'inizio.

Esempi: prenotazione per domani sera, 24 ore per firmare; prenotazione tra 5 giorni, circa
58 ore; prenotazione tra 10 giorni o oltre, 4 giorni pieni e slot di nuovo libero con almeno
altrettanto anticipo sulla partita.

Il reminder al referente parte 6 ore prima della scadenza, o a meta' finestra quando questa e'
piu' corta di 12 ore, cosi' anche le finestre brevi ricevono un avviso utile e non subito dopo
la creazione. La finestra parte da `signatureWindowStartedAt`, non da `createdAt`: dopo una
rinuncia o una modifica che azzera le firme l'inizio si sposta ad adesso, quindi la prenotazione
non risulta col sollecito gia' scaduto. Il reminder e' unico: `signatureReminderSentAt` registra
il singolo invio e l'audit ne riflette l'esito reale (`SENT`/`FAILED`), senza resettare il claim
se la mail non parte.

Il job `.github/workflows/signature-deadlines.yml` chiama ogni 10 minuti
`POST /api/internal/signature-deadlines` con `Authorization: Bearer <APP_INTERNAL_CRON_SECRET>`.
Il valore deve esistere sia nei GitHub Actions secrets sia in `.env.production`; il workflow
`Deploy Production` lo sincronizza su `.env.production` durante il deploy. Se il secret non e'
configurato il workflow scadenze salta; l'app esegue comunque una pulizia opportunistica su
disponibilita', lookup e firma ospiti. La pulizia opportunistica ingoia i propri errori per non
far fallire la richiesta utente che la ospita; solo il cron chiama il processore direttamente e
ne vede gli errori.

La run del workflow fallisce in modo visibile non solo sugli HTTP di errore, ma anche se il
corpo della risposta non riporta `ok:true`. Ogni run che sollecita o annulla almeno una pending
scrive una riga di audit riassuntiva (`SIGNATURE_DEADLINES_RUN`, con `reminded`/`canceled`),
cosi' l'admin ha una traccia datata dell'attivita'; le run a vuoto non scrivono nulla.

## Documentazione Operativa

- Runbook AWS/Lightsail: [`docs/aws-deploy.md`](docs/aws-deploy.md)
- Stato produzione e checklist: [`docs/production-runbook.md`](docs/production-runbook.md)
- Security audit: [`docs/security-audit.md`](docs/security-audit.md)
- Checklist Bitwarden: [`docs/bitwarden-checklist.md`](docs/bitwarden-checklist.md)
- Istruzioni agenti/Codex: [`AGENTS.md`](AGENTS.md)
