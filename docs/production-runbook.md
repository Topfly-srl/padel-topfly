# Stato Produzione E Checklist

Documento di stato per Padel TOPFLY aggiornato dopo il primo deploy AWS.

## Produzione Attiva

URL:

- <https://padel.topflysolutions.com>

## Stato Modifiche

- **Locale**: modifiche nel working tree Codex/Mac. Non sono in produzione finche' non
  vengono committate e pushate su GitHub.
- **GitHub**: modifiche presenti su `main`. Il push avvia la CI del workflow
  `Deploy Production`; con `PRODUCTION_AUTO_DEPLOY=false` il job deploy resta skipped e va
  lanciato manualmente da GitHub Actions.
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
- Scarico responsabilita' digitale obbligatorio per referente e ospiti.
- PDF scarico responsabilita' archiviato nel DB e inviato alla shared mailbox
  `padel@topflysolutions.com`.
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
- Repository variable `PRODUCTION_AUTO_DEPLOY=false`: il push su `main` esegue CI, poi il deploy
  Lightsail va lanciato manualmente se il job deploy risulta skipped.
- Backup pre-deploy salvato fuori repo in `/var/backups/padel-topfly`.
- Backup notturno automatico del database (`scripts/backup.sh` via cron `03:15`, dump gzippati con
  retention 14 giorni), installato dal deploy in `/etc/cron.d/padel-backup`.
- Container `app` hardenizzato con utente non-root, `no-new-privileges` e capabilities rimosse.
- API sensibili con `Cache-Control: no-store`.
- Controllo Origin/Referer attivo sulle mutazioni in produzione.
- Rate limit attivo per IP e per email globale su creazione prenotazione.
- Audit log sanificato da token/hash e dettagli tecnici Graph.
- Cancellazione Outlook ritentabile se una cancellazione precedente fallisce.
- Avvio produzione fail-fast se mancano env critiche.
- Checklist Bitwarden creata in `docs/bitwarden-checklist.md`.
- Istruzioni operative per Codex/agenti create in `AGENTS.md`.
- Report security audit creato in `docs/security.md`.

## Cosa Non E' Ancora Fatto

- Snapshot automatici Lightsail off-box da abilitare in console per una copia del disco fuori
  dalla macchina. Il backup notturno del database su disco e' gia' attivo (cron `03:15`, vedi
  "Backup E Ripristino"): qui resta solo la copia off-box.
- Monitoraggio/alerting non ancora configurato.
- Verifica che il permesso Graph `Mail.Send` sia limitato alla sola mailbox Padel.
- Limitazione dei permessi Graph Application alla sola mailbox Padel tramite Exchange
  Application Access Policy/RBAC, da verificare manualmente.
- Branch protection su `main` da valutare/abilitare.
- Eventuale pagina/documento interno per annunciare il link ai dipendenti.

## Test Da Fare Prima Di Annunciare In Azienda

Da browser normale:

1. Aprire <https://padel.topflysolutions.com>.
2. Creare una prenotazione con nome e email aziendale.
3. Compilare e firmare lo scarico responsabilita' del referente.
4. Copiare il link firma ospiti e firmare come ospite in finestra anonima/mobile.
5. Verificare che il PDF firmato arrivi nella mailbox condivisa `padel@topflysolutions.com` e,
   per la firma del referente, che la sua copia arrivi anche alla casella del referente: sono
   due invii separati, e in `/admin` devono risultare due stati distinti ("PDF Direzione" e
   "Copia referente").
6. Verificare che lo slot risulti occupato con solo nome visibile.
7. Verificare "Le mie prenotazioni".
8. Modificare la prenotazione e verificare che venga generato un nuovo link ospiti.
9. Cancellare la prenotazione e verificare la mail `Canceled:` nativa Outlook.
10. Creare due prenotazioni future con la stessa email.
11. Tentare una terza prenotazione futura con la stessa email e verificare il blocco.

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
  - `strict-transport-security: max-age=86400` (vedi nota HSTS piu' sotto);
  - `referrer-policy: no-referrer` sulle pagine token (`/manage/*`, `/waiver/*`, `/w/*`);
  - assenza di `x-powered-by`.

### Nota HSTS (max-age progressivo)

L'header `Strict-Transport-Security` parte volutamente basso: `max-age=86400` (un giorno), senza
`includeSubDomains` ne `preload`. Motivo: un errore HSTS con `max-age` lungo (certificato scaduto,
un sottodominio raggiungibile solo in HTTP) chiuderebbe fuori tutti i browser fino alla scadenza del
valore, senza possibilita' di rientro rapido. Con un giorno il raggio d'azione di un eventuale errore
resta piccolo.

Piano di innalzamento: dopo qualche settimana di HTTPS senza problemi (certificato che si rinnova da
solo, nessun sottodominio in chiaro), alzare il valore in `docker/Caddyfile` a
`Strict-Transport-Security "max-age=31536000"` (un anno) e riavviare Caddy. Valutare
`includeSubDomains`/`preload` solo dopo aver verificato che ogni sottodominio serva HTTPS.

## Procedura Aggiornamento Codice

Locale:

```bash
npm run lint
npm test
npm run build
DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
npm audit --omit=dev
git status --short
```

Dopo commit/push su `main`, GitHub Actions esegue la CI del workflow `Deploy Production`.
Se `PRODUCTION_AUTO_DEPLOY=true`, parte anche il deploy Lightsail; con il valore corrente
`PRODUCTION_AUTO_DEPLOY=false`, il deploy Lightsail va lanciato manualmente con
`Run workflow` o `gh workflow run "Deploy Production" --ref main`.

### Procedura Standard: Manda Tutto Online

Questa e' la procedura da seguire quando l'utente chiede di "mandare online", "mandare in
produzione", "pubblicare", "fare deploy" o simili.

1. Verificare il working tree:

   ```bash
   git status --short --branch
   ```

2. Eseguire tutti i check locali:

   ```bash
   npm run lint
   npm test
   npm run build
   DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
   npm audit --omit=dev
   ```

3. Fare commit e push su `main`.

4. Controllare la run `Deploy Production`:

   ```bash
   gh run list --workflow "Deploy Production" --limit 5
   ```

   Se il push ha eseguito solo CI o il job deploy e' skipped per
   `PRODUCTION_AUTO_DEPLOY` spento, lanciare manualmente:

   ```bash
   gh workflow run "Deploy Production" --ref main
   gh run watch <run-id> --exit-status
   ```

5. A deploy verde, verificare produzione:

   ```bash
   curl --fail --silent --show-error --head https://padel.topflysolutions.com
   curl --fail --silent --show-error \
     "https://padel.topflysolutions.com/api/availability?date=$(date -u +%F)"
   ```

6. Verificare il cron firme:

   ```bash
   gh workflow run "Signature Deadlines" --ref main
   gh run watch <run-id> --exit-status
   gh run view <run-id> --log
   ```

   Il log deve contenere una risposta tipo `{"ok":true,"reminded":0,"canceled":0}` e non
   `APP_INTERNAL_CRON_SECRET is not configured`.

7. Verificare che l'endpoint interno sia protetto e configurato:

   ```bash
   curl --silent --show-error --dump-header - --output - \
     --request POST https://padel.topflysolutions.com/api/internal/signature-deadlines
   ```

   Risultato atteso senza token: `401 Non autorizzato`. Se risponde
   `503 Cron interno non configurato`, il secret non e' arrivato in `.env.production` o il
   container non e' stato ricreato dopo la modifica.

8. Chiudere il lavoro solo dopo aver riportato: commit, URL run deploy, URL run cron,
   check locali, health check produzione e stato del working tree.

Nota: una run schedulata di `Signature Deadlines` puo' fallire con `503` se parte mentre
`Deploy Production` sta ricreando i container. In quel caso non basta ignorarla: dopo il
deploy verde rilanciare manualmente `Signature Deadlines` e confermare che passi.

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

1. esegue CI (`npm run lint`, `npm test`, `npm run build`, `npx prisma validate`
   con `DATABASE_URL` fittizio di CI, `npm audit --omit=dev`);
2. valida che i secrets SSH siano presenti;
3. entra su Lightsail via SSH;
4. crea un dump Postgres in `/var/backups/padel-topfly` se il container Postgres e'
   gia' disponibile; altrimenti segnala il backup skipped;
5. esegue `git pull --ff-only origin main`;
6. installa/aggiorna in modo idempotente lo script di backup notturno in
   `/usr/local/bin/padel-backup.sh` e il cron `/etc/cron.d/padel-backup` (vedi
   "Backup E Ripristino");
7. ricostruisce Docker Compose;
8. riavvia Caddy per ricaricare eventuali modifiche al proxy/header;
9. esegue health check su <https://padel.topflysolutions.com> e su
   `/api/availability`, verificando anche `Cache-Control: no-store`.

Le migrazioni Prisma NON girano nel workflow: le applica `docker/entrypoint.sh` con
`npx prisma migrate deploy` all'avvio del container, quindi la ricostruzione al passo 7
porta in produzione ogni migrazione ancora da applicare. Le migrazioni del progetto sono
pensate additive e retrocompatibili (colonne nullable con fallback sui record esistenti), cosi'
un deploy applica lo schema nuovo senza rompere i dati gia' presenti. Prisma 7: il client e'
generato in `src/generated/prisma` e usa l'adapter `pg`; il bootstrap di un DB vuoto va fatto
solo con `prisma migrate deploy` (mai `prisma db push`, che non crea l'unique index parziale
sulle firme ACTIVE).

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

I log di ogni servizio (app, postgres, caddy) usano il driver `json-file` con rotazione
`max-size: 10m` e `max-file: 3`, quindi non riempiono il disco senza intervento manuale.

## Workflow GitHub Actions

Tutti i workflow vivono in `.github/workflows/` e si lanciano da GitHub Actions o con
`gh workflow run "<Nome>" --ref main`.

- **Deploy Production** (`deploy-production.yml`): CI (lint, test, integrazione, build, prisma
  validate, audit) e, su `workflow_dispatch` o con `PRODUCTION_AUTO_DEPLOY=true`, deploy su
  Lightsail. Vedi "Procedura Aggiornamento Codice".
- **Signature Deadlines** (`signature-deadlines.yml`): ogni 10 minuti chiama
  `POST /api/internal/signature-deadlines` col cron secret. Vedi "Scadenze firme".
- **Health Check** (`health-check.yml`): ogni 15 minuti sonda home e `/api/availability`; tiene
  anche vivo lo scheduling dei cron del repo. Vedi "Health check esterno".
- **Provision Swap** (`provision-swap.yml`): idempotente, crea/riattiva 2 GB di swap persistente
  sul box da 1 GB. Vedi "Trappola: swap e OOM in build" qui sotto.
- **Diagnose Production** (`diagnose-production.yml`): manuale, raccoglie check di configurazione,
  conteggi DB anonimizzati e log app/caddy per una diagnosi senza esporre dati personali.

### Trappola: swap e OOM in build (box 1 GB)

L'istanza Lightsail ha **1 GB di RAM** e `next build` gira SUL server durante il deploy. Senza
swap la build esaurisce la memoria e **congela l'intera istanza**: sito e SSH irraggiungibili,
recupero solo con `Reboot` dalla console Lightsail. E' gia' successo dopo un reboot che aveva
perso lo swap non persistito in `/etc/fstab`.

Regola operativa:

- lo swap 2 GB deve essere attivo E persistito in `/etc/fstab`;
- il workflow **Provision Swap** lo garantisce in modo idempotente:
  `gh workflow run "Provision Swap" --ref main`;
- dopo un reboot dell'istanza, se `free -h` non mostra piu' lo swap, rilanciare Provision Swap
  PRIMA del deploy successivo;
- il deploy SSH usa `ServerAliveInterval=30` come keepalive perche' la fase TypeScript della
  build resta muta a lungo e senza probe la connessione cadrebbe ("Broken pipe").

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
- Repository variable `PRODUCTION_AUTO_DEPLOY=false` oppure `true`, in base alla policy deploy
  scelta; quando e' `false`, usare `Run workflow` per `Deploy Production`.

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
4. Verificare che `Mail.Send` sia presente ma limitato alla sola mailbox Padel.
5. Limitare `Calendars.ReadWrite` alla mailbox `padel@topflysolutions.com`.
6. Abilitare gli snapshot automatici Lightsail in console (il backup database schedulato e' gia'
   attivo, vedi "Backup E Ripristino").
7. Preparare messaggio interno con link e regole d'uso.

## Microsoft Graph

App registration: `Padel TOPFLY Admin`.

Permessi Graph richiesti:

- `Calendars.ReadWrite` Application, consenso admin concesso.
- `Mail.Send` Application, consenso admin concesso.

`Mail.Send` e' usato per inviare il PDF dello scarico responsabilita' firmato alla mailbox
condivisa configurata in `APP_WAIVER_RECIPIENT_EMAIL` e per le email agli ospiti firmatari.
In produzione il valore atteso e' `padel@topflysolutions.com`, cosi' gli scarichi restano
nella casella Padel e non intasano una casella personale. Conferme, modifiche e cancellazioni
del referente restano sugli inviti/eventi Outlook; gli ospiti gia' firmatari ricevono una
notifica custom se la prenotazione cambia o viene annullata.

La mailbox usata dall'app e':

```txt
padel@topflysolutions.com
```

Configurazione destinatario scarichi:

```env
MS_GRAPH_MAILBOX=padel@topflysolutions.com
APP_WAIVER_RECIPIENT_EMAIL=padel@topflysolutions.com
```

La mailbox `padel@topflysolutions.com` puo' essere aperta dagli utenti autorizzati con
permesso Exchange `FullAccess`. Non serve concedere `SendAs` se l'utente deve solo leggere
o gestire gli scarichi ricevuti.

Conferme:

- la prenotazione nasce `PENDING_SIGNATURES` e blocca temporaneamente lo slot;
- l'evento Outlook nel calendario `padel@topflysolutions.com` viene creato solo quando le
  firme attive arrivano a `playerCount/playerCount`;
- l'invito viene inviato all'email inserita nel form solo a firme complete;
- includono reminder Outlook 1 ora prima;
- la mail provvisoria al referente include link di gestione, link firma ospiti e scadenza firme;
- se mancano firme, il referente riceve un reminder prima della scadenza e una mail di
  annullamento se la pending scade incompleta.

Scarichi responsabilita':

- il referente firma durante la prenotazione;
- dopo la prenotazione il referente vede il link ospiti completo e puo' copiarlo o aprirlo;
- senza tutte le firme lo stato resta `PENDING_SIGNATURES` e il campo non va considerato
  utilizzabile;
- gli ospiti firmano da `/waiver/[bookingId]?token=...`;
- gli ospiti ricevono una mail di conferma con allegato calendario `.ics` e link personale
  per rinunciare al posto;
- se il referente modifica la prenotazione, gli ospiti gia' firmatari ricevono una mail con
  nuovo orario, nuovo link firma ospiti e la nuova scadenza entro cui rifirmare;
- se il referente cancella la prenotazione, gli ospiti gia' firmatari ricevono una mail di
  cancellazione con allegato calendario `.ics`;
- l'ospite vede il link "rinuncia al posto" solo finche' la rinuncia e' davvero possibile (flag
  `canCancel`: firma attiva e partita non ancora iniziata), cosi' l'interfaccia non promette
  un'azione che il server rifiuterebbe con 409;
- se un ospite rinuncia, la firma resta nello storico ma non conta piu' nel limite giocatori;
- firma e rinuncia ospiti girano in transazione Serializable con retry automatico sui conflitti,
  perche' il PDF viene generato fuori dalla transazione e piu' firme possono arrivare insieme;
- se una rinuncia porta una prenotazione confermata sotto `playerCount/playerCount`, la
  prenotazione torna `PENDING_SIGNATURES` e l'evento Outlook viene cancellato/invalidato;
- quando le firme attive arrivano a `playerCount/playerCount`, il link ospiti non permette
  nuove firme;
- ogni firma genera un PDF archiviato in Postgres;
- l'app invia il PDF alla mailbox condivisa Padel tramite Graph `sendMail`;
- il PDF del referente parte con DUE `sendMail` distinti, tracciati separatamente: la copia
  all'archivio legale (`emailStatus`/`emailError`, destinatario `APP_WAIVER_RECIPIENT_EMAIL`) e
  la copia al referente stesso (`signerEmailStatus`/`signerEmailError`). Le firme ospite non
  prevedono copia al firmatario: `signerEmailStatus` resta `SKIPPED` senza errore, e la loro
  mail di conferma e' un'altra cosa ancora (`guestEmailStatus`);
- un esito non contamina l'altro: l'archivio puo' risultare `SENT` mentre la copia al referente
  e' `FAILED`, e in quel caso l'area admin mostra "PDF Direzione Inviata" accanto a "Copia
  referente Da reinviare";
- se l'invio fallisce, l'admin puo' filtrare gli scarichi per stato e ritentare da `/admin`. Il
  reinvio manda SOLO le copie non riuscite (`FAILED`, oppure `SKIPPED` con errore, cioe' non
  partite): quella gia' arrivata non viene duplicata. Se sono a posto entrambe la API risponde
  409 e il pulsante non compare;
- le firme antecedenti alla migrazione `20260717025831_waiver_signer_copy_email_status` hanno
  `signerEmailStatus = SKIPPED` senza errore: la colonna e' nuova, per loro la copia al referente
  non e' mai stata tracciata e non risulta da reinviare.

Scadenze firme:

- deadline standard: prima tra meta' del tempo mancante (minimo 24 ore, massimo 4 giorni) dalla
  creazione e 4 ore prima dell'inizio;
- prenotazioni last minute: prima tra 30 minuti dalla creazione e l'inizio;
- workflow schedulato: `.github/workflows/signature-deadlines.yml`, ogni 10 minuti;
- endpoint interno: `POST /api/internal/signature-deadlines`;
- secret richiesto: `APP_INTERNAL_CRON_SECRET`, salvato nei GitHub Actions secrets e
  sincronizzato in `.env.production` dal workflow `Deploy Production`;
- il reminder al referente cade 6 ore prima della scadenza, o a meta' finestra se questa e' piu'
  corta di 12 ore; la finestra parte da `signatureWindowStartedAt`, che si sposta ad adesso dopo
  una rinuncia o una modifica che azzera le firme;
- dopo ogni deploy, rilanciare manualmente `Signature Deadlines` e verificare `{"ok":true,...}`;
- la run del workflow fallisce in modo visibile non solo sugli HTTP di errore, ma anche se il
  corpo non riporta `ok:true`;
- ogni run che sollecita o annulla almeno una pending scrive una riga di audit riassuntiva
  (`SIGNATURE_DEADLINES_RUN`, con `reminded`/`canceled`); le run a vuoto non scrivono nulla;
- battito giornaliero: solo la route interna del cron passa `heartbeat: true`, quindi al primo
  giro del giorno (confini calcolati con il timezone dell'app) viene scritta UNA riga
  `SIGNATURE_DEADLINES_HEARTBEAT` (`actorEmail` `system`, `entityType` `System`), con guardia
  sulla riga di oggi per non duplicarla ai giri successivi. La pulizia opportunistica NON scrive
  il battito: se lo facesse, il traffico utente lo scriverebbe al posto del cron e mascherebbe un
  cron fermo. Il battito e' quindi la traccia che il cron ha girato anche in una giornata senza
  pending, quando `SIGNATURE_DEADLINES_RUN` non comparirebbe mai;
- ritenzione audit: insieme al battito (quindi una sola volta al giorno, sul primo giro del cron)
  vengono cancellate le righe `AuditLog` con `createdAt` oltre `APP_AUDIT_RETENTION_MONTHS` mesi
  (default 24). Il numero di righe potate finisce nel corpo della run come `auditPruned`; per
  allungare o accorciare lo storico basta cambiare `APP_AUDIT_RETENTION_MONTHS` nell'env dell'app.
- se il workflow non gira, l'app fa comunque pulizia opportunistica su calendario, lookup e
  firma ospiti, ma ingoia i propri errori per non far fallire la richiesta utente che la ospita.
  La pulizia opportunistica ha un throttle di 60s (giri utente ravvicinati saltano i findMany a
  vuoto); il cron non passa dal throttle e resta la via affidabile.

Diagnosi cron fermo:

- segnale tipico: nella lista admin restano pending vecchie che invecchiano oltre la loro
  scadenza senza essere annullate ne' sollecitate. Una prenotazione ancora `PENDING_SIGNATURES`
  con `signatureDeadlineAt` passata da piu' cicli da 10 minuti indica un cron `Signature
  Deadlines` fermo o in errore;
- conferma piu' diretta, indipendente dal fatto che ci siano pending: se nella pagina admin
  audit manca la riga `SIGNATURE_DEADLINES_HEARTBEAT` di oggi, il cron non ha girato nemmeno una
  volta oggi. A DB la query e':

  ```sql
  SELECT "createdAt" FROM "AuditLog"
  WHERE action = 'SIGNATURE_DEADLINES_HEARTBEAT'
  ORDER BY "createdAt" DESC LIMIT 5;
  ```

  Il battito piu' recente e' la conferma dell'ultimo giorno in cui il cron ha effettivamente
  chiamato la route interna; se e' di ieri o piu' vecchio, il cron e' fermo;
- conferma: nell'audit non compaiono righe `SIGNATURE_DEADLINES_RUN` recenti, oppure la lista
  run mostra esecuzioni mancanti o rosse:

  ```bash
  gh run list --workflow "Signature Deadlines" --limit 10
  ```

- rilancio manuale e verifica:

  ```bash
  gh workflow run "Signature Deadlines" --ref main
  gh run watch <run-id> --exit-status
  gh run view <run-id> --log
  ```

  Il log deve chiudersi con `{"ok":true,...}`. Una pending scaduta viene comunque chiusa alla
  prima richiesta utente grazie alla pulizia opportunistica, ma non e' garanzia sufficiente se su
  quel percorso non arriva traffico: il cron resta la via affidabile.

Health check esterno:

- workflow `.github/workflows/health-check.yml`, schedule ogni 15 minuti piu' `workflow_dispatch`;
- sonda due endpoint con `curl --fail --silent --max-time 15`: la home
  `https://padel.topflysolutions.com` e l'API disponibilita'
  `https://padel.topflysolutions.com/api/availability?date=<oggi>` (la data odierna e' calcolata
  a runtime nel job). Se uno dei due non risponde 2xx entro 15 secondi, il job esce con codice 1
  e la run risulta rossa;
- notifica: una run fallita e' un workflow fallito, quindi GitHub manda la notifica standard di
  Actions a chi segue il repo (watch su Actions / owner). Non c'e' integrazione esterna: la
  notifica arriva dal repo stesso, quindi chi deve accorgersene deve avere le notifiche Actions
  attive;
- effetto collaterale utile: il workflow tiene vivo lo scheduling del repo. GitHub sospende i
  cron dopo 60 giorni senza attivita', quindi una sonda che gira ogni 15 minuti evita che anche
  il cron `Signature Deadlines` venga spento su un repo tranquillo;
- rilancio manuale: `gh workflow run "Health Check" --ref main`, poi
  `gh run watch <run-id> --exit-status`.

Privacy e retention:

- il DB conserva dati personali, firma immagine, PDF firmato, hash IP/User-Agent e stati email;
- prima del go-live produzione, TOPFLY deve confermare tempi di conservazione e procedura di
  richiesta/cancellazione dati;
- evitare prenotazioni di prova non concordate e rimuoverle/cancellarle quando non servono piu'.

Cancellazioni:

- cancellano l'evento Outlook tramite Graph `event/cancel`;
- non fanno un update evento prima del cancel, per evitare doppie mail su Gmail/Google
  Calendar;
- il commento del cancel e' differenziato: una cancellazione vera usa il testo di annullamento,
  mentre una prenotazione confermata che perde una firma ritira l'evento con un commento "firme
  mancanti", perche' la prenotazione resta valida e torna solo in attesa;
- se ad annullare e' un admin diverso dal referente, l'organizzatore riceve una mail dedicata di
  annullamento dall'amministrazione, senza esporre chi ha annullato;
- gli ospiti gia' firmatari ricevono una mail custom separata, perche' non sono invitati
  diretti dell'evento Outlook principale.

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

## Backup E Ripristino

### Dove Stanno I Dump E Con Che Retention

- Tutti i dump vivono in `/var/backups/padel-topfly` sull'istanza Lightsail (fuori dal
  repo). Sono file `padel_topfly_AAAAMMGG-HHMMSS.sql.gz`.
- Backup notturno automatico: `scripts/backup.sh`, installato dal deploy in
  `/usr/local/bin/padel-backup.sh` e schedulato via `/etc/cron.d/padel-backup` alle
  `03:15` come utente `root`. L'output di ogni run viene appeso a
  `/var/log/padel-backup.log`.
- Lo script fa `pg_dump` (stesso comando del pre-deploy), lo comprime con `gzip` e pota
  automaticamente i dump piu' vecchi di 14 giorni. Con una riga di log a notte, il file
  di log resta piccolo e non serve logrotate.
- I dump pre-deploy creati dal workflow `Deploy Production` finiscono nella stessa
  cartella e seguono la stessa retention (li pota il cron notturno).

Attenzione: questi dump vivono sulla stessa macchina che dovrebbero proteggere. Per una
copia fuori dalla macchina servono gli snapshot Lightsail (vedi in fondo).

### Verificare Che Il Backup Notturno Giri

```bash
ls -lh /var/backups/padel-topfly | tail
sudo tail -n 20 /var/log/padel-backup.log
cat /etc/cron.d/padel-backup
```

Ci si aspetta un dump `.sql.gz` nuovo ogni notte e una riga di log `Dump completato`
per ciascuna esecuzione.

### Backup Manuale Immediato

Prima di un deploy importante, o per una copia al volo, si puo' lanciare lo stesso
script del cron:

```bash
sudo /usr/local/bin/padel-backup.sh
```

In alternativa, il dump manuale grezzo (non compresso):

```bash
cd /opt/padel-topfly
BACKUP_DIR=/var/backups/padel-topfly
sudo install -d -m 750 -o "$(whoami)" -g "$(id -gn)" "$BACKUP_DIR"
sudo docker compose -f docker-compose.production.yml exec -T postgres \
  pg_dump -U padel -d padel_topfly \
  > "$BACKUP_DIR/padel_topfly_$(date +%Y%m%d-%H%M%S).sql" < /dev/null
ls -lh "$BACKUP_DIR" | tail
```

### Procedura Di Restore (Da Provare Una Volta)

Un backup non provato non e' un backup. La procedura sotto ripristina un dump in un
database di PROVA dentro lo stesso container Postgres, senza toccare il database di
produzione, e verifica che le migrazioni Prisma tornino.

1. Scegliere il dump da ripristinare:

   ```bash
   ls -lh /var/backups/padel-topfly
   DUMP=/var/backups/padel-topfly/padel_topfly_AAAAMMGG-HHMMSS.sql.gz
   ```

2. Creare un database di prova (NON toccare `padel_topfly`):

   ```bash
   cd /opt/padel-topfly
   sudo docker compose -f docker-compose.production.yml exec -T postgres \
     psql -U padel -d postgres -c 'CREATE DATABASE padel_restore_test;' < /dev/null
   ```

3. Caricare il dump gzippato nel database di prova:

   ```bash
   gunzip -c "$DUMP" | sudo docker compose -f docker-compose.production.yml exec -T \
     postgres psql -U padel -d padel_restore_test
   ```

   (Per un dump grezzo `.sql` non compresso usare `cat "$DUMP" | ...` al posto di
   `gunzip -c`.)

4. Verificare lo stato delle migrazioni Prisma sul database ripristinato. Si riusa il
   `DATABASE_URL` del container app cambiando solo il nome del database, cosi' non si
   espone la password:

   ```bash
   sudo docker compose -f docker-compose.production.yml exec -T app sh -lc '
     RESTORE_URL="$(printf "%s" "$DATABASE_URL" | sed "s#/padel_topfly#/padel_restore_test#")"
     DATABASE_URL="$RESTORE_URL" npx prisma migrate status' < /dev/null
   ```

   Atteso: `Database schema is up to date!`. Se compaiono migrazioni non applicate o un
   mismatch, il dump o lo schema non sono allineati: indagare prima di considerare il
   backup valido.

5. Eliminare il database di prova:

   ```bash
   sudo docker compose -f docker-compose.production.yml exec -T postgres \
     psql -U padel -d postgres -c 'DROP DATABASE padel_restore_test;' < /dev/null
   ```

Raccomandazione: eseguire questa procedura almeno una volta subito dopo aver abilitato
il backup notturno e annotare qui sotto l'esito (data, dump usato, output di
`prisma migrate status`). Ripeterla dopo cambi importanti allo schema.

Esito ultimo test di restore: _da compilare al primo test._

### Snapshot Automatici Lightsail (Azione Committente)

I dump `.sql.gz` proteggono i dati ma restano sul disco dell'istanza: se si perde la
macchina si perdono anche i backup. Per una copia fuori dalla macchina, abilitare gli
snapshot automatici dell'istanza dalla console AWS Lightsail:

- Lightsail, istanza `padel-topfly`, scheda `Snapshots`;
- attivare `Automatic snapshots` scegliendo un orario notturno;
- gli snapshot coprono l'intero disco (DB, volumi Docker, `.env.production`) e vivono
  fuori dall'istanza.

Questa e' un'azione manuale in console a carico del committente, non automatizzabile dal
deploy.

Non usare `docker compose down -v` in produzione: elimina il volume Postgres.

## Ambiente Di Staging

Ambiente di prova minimale che gira sullo STESSO host della produzione (o in locale),
descritto in `docker-compose.staging.yml`. Serve a provare una migrazione o una build
prima di toccare la produzione dei colleghi.

Cosa e' e cosa NON e':

- solo due servizi: `app` + un Postgres dedicato. Niente Caddy, niente dominio, niente
  HTTPS;
- NON riceve traffico pubblico: l'app e' bindata su `127.0.0.1:8080` e si raggiunge solo
  via SSH tunnel dalla propria macchina;
- NON ha cron: i workflow `Signature Deadlines` e `Health Check` puntano solo alla
  produzione. Lo staging non viene sollecitato da nessun cron;
- e' un progetto Docker Compose separato (`name: padel-staging`), quindi container, rete e
  volume NON collidono con la produzione: il volume dati e' `padel_staging_pgdata`, distinto
  da quello di produzione;
- il deploy dello staging e' MANUALE via SSH. Il workflow `Deploy Production` non lo tocca:
  non esiste automazione per lo staging, e va bene cosi'.

Env: copiare `.env.staging.example` in `.env.staging` e riempirlo. Contiene solo valori di
prova, MAI secret veri (Graph/Entra restano vuoti apposta, cosi' lo staging non manda inviti
ne' mail). Il file `.env.staging` e' gitignorato.

### Tirarlo Su

Sul server (o in locale, stessi comandi senza `sudo` in locale):

```bash
cd /opt/padel-topfly            # in locale: la cartella del repo
cp .env.staging.example .env.staging   # solo la prima volta, poi editare
sudo docker compose -f docker-compose.staging.yml up -d --build
sudo docker compose -f docker-compose.staging.yml ps
```

L'immagine e' la stessa buildata dal repo (stesso `Dockerfile` della produzione). All'avvio
`docker/entrypoint.sh` esegue gia' `npx prisma migrate deploy` contro il DB staging, quindi il
solo `up` porta lo schema staging all'ultima migrazione.

Accesso dalla propria macchina via SSH tunnel (lo staging NON e' esposto su Internet):

```bash
ssh -L 8080:127.0.0.1:8080 ubuntu@18.194.7.194
# poi nel browser locale: http://localhost:8080
```

### Provare Una Migrazione

Il modo consigliato e' rifare `up`: la ricostruzione riavvia l'app e l'entrypoint applica le
migrazioni ancora da eseguire sul DB staging.

```bash
cd /opt/padel-topfly
git pull --ff-only origin main   # o il branch con la migrazione da provare
sudo docker compose -f docker-compose.staging.yml up -d --build
sudo docker compose -f docker-compose.staging.yml logs app | grep -i migrat
```

In alternativa, applicare le migrazioni a mano senza ricostruire, dal container app gia' su:

```bash
sudo docker compose -f docker-compose.staging.yml exec -T app npx prisma migrate deploy
sudo docker compose -f docker-compose.staging.yml exec -T app npx prisma migrate status
```

Atteso: `Database schema is up to date!`. Se la migrazione fallisce qui, si e' rotta solo lo
staging: la produzione non e' stata toccata. Indagare e correggere prima di portare la
migrazione in produzione con la procedura standard di deploy.

### Spegnerlo

```bash
cd /opt/padel-topfly
sudo docker compose -f docker-compose.staging.yml down
```

`down` senza `-v` lascia il volume `padel_staging_pgdata`, quindi i dati di prova restano al
prossimo `up`. Per ripartire da un DB vuoto (solo staging, MAI in produzione):

```bash
sudo docker compose -f docker-compose.staging.yml down -v
```

Il `-v` qui e' sicuro perche' colpisce solo il volume staging dedicato, non quello di
produzione. Verificare comunque sempre di aver passato `-f docker-compose.staging.yml`.

## Provisioning Iniziale Del Server (Una Tantum)

Riferimento per preparare da zero una nuova istanza. In esercizio normale non serve: il deploy
gira su un'istanza gia' provisionata (`padel-topfly`, Frankfurt `eu-central-1`, 1 GB RAM / 2 vCPU
/ 40 GB SSD, static IP `18.194.7.194`, path `/opt/padel-topfly`).

### DNS

Il DNS di `topflysolutions.com` e' gestito da cPanel/Serverplan. Record richiesto:

```txt
Tipo: A
Nome: padel
Valore: 18.194.7.194
TTL: default oppure 300
```

Verifica: `dig +short A padel.topflysolutions.com` deve dare `18.194.7.194`; poi
`curl -I https://padel.topflysolutions.com` (atteso `HTTP/2 200`) e
`curl -I http://padel.topflysolutions.com` (atteso `308`).

### Firewall Lightsail

Aprire solo SSH `TCP 22`, HTTP `TCP 80`, HTTPS `TCP 443` (idem su IPv6 se attivo). Niente load
balancer, CDN o database gestito.

### Bootstrap Ubuntu

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

Lo **swap 2 GB e' obbligatorio** su questo box (vedi "Trappola: swap e OOM in build"): usare il
workflow Provision Swap, oppure a mano `fallocate -l 2G /swapfile`, `chmod 600`, `mkswap`,
`swapon`, e la riga `/swapfile none swap sw 0 0` in `/etc/fstab` per la persistenza.

### Struttura Docker

`docker-compose.production.yml` avvia `app` (immagine Next.js dal `Dockerfile`), `postgres`
(`postgres:16-alpine`, volume `padel_topfly_pgdata`) e `caddy` (`caddy:2-alpine`, porte 80/443).
L'entrypoint dell'app esegue `npx prisma migrate deploy` e poi `npm start`. Il servizio `app` gira
non-root con `no-new-privileges` e `cap_drop: ALL`; Caddy tiene i security header a livello proxy
e riscrive `X-Real-IP`/`X-Forwarded-For` col client IP reale.

### Creazione `.env.production`

```bash
cd /opt/padel-topfly
cp .env.production.example .env.production
chmod 600 .env.production
openssl rand -base64 32   # AUTH_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD (hex: niente URL-encoding in DATABASE_URL)
```

Valori attesi (i secret veri vanno in Bitwarden, mai in Git):

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

MS_GRAPH_TENANT_ID=...
MS_GRAPH_CLIENT_ID=...
MS_GRAPH_CLIENT_SECRET=...
MS_GRAPH_MAILBOX=padel@topflysolutions.com
APP_WAIVER_RECIPIENT_EMAIL=padel@topflysolutions.com
```

`APP_DOMAIN` con dominio HTTPS non deve avere `:` davanti: corretto
`APP_DOMAIN=padel.topflysolutions.com`, errato `APP_DOMAIN=:padel.topflysolutions.com`
(`:80` vale solo per test temporanei via IP e HTTP).

### Problemi Gia' Incontrati

- **Build Docker lenta / ferma su `npm ci` o TypeScript**: quasi sempre memoria; assicurarsi che
  lo swap 2 GB sia attivo (Provision Swap) e usare `tmux` per non perdere la sessione SSH.
- **Caddy `invalid port 'padel.topflysolutions.com'`**: causato da `APP_DOMAIN` con `:` davanti;
  correggere in `APP_DOMAIN=padel.topflysolutions.com` e `up -d`.
- **HTTPS non parte**: verificare che il record `A` punti a `18.194.7.194`, che 80/443 siano
  aperte su Lightsail, che `APP_DOMAIN` sia corretto e leggere i log Caddy.

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
