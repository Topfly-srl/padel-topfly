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
- Report security audit creato in `docs/security-audit.md`.

## Cosa Non E' Ancora Fatto

- Backup notturno del database configurato (cron `03:15`, vedi "Backup E Ripristino"); resta
  da abilitare in console gli snapshot automatici Lightsail per una copia fuori dalla macchina.
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
  - assenza di `x-powered-by`.

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
`npx prisma migrate deploy` all'avvio del container, quindi la ricostruzione al passo 6
porta in produzione ogni migrazione ancora da applicare. Questo deploy include
`20260715093942_signature_window_started_at`, che aggiunge la colonna nullable
`Booking.signatureWindowStartedAt` (inizio della finestra firme, usato dal sollecito dopo una
rinuncia): e' additiva e retrocompatibile, i record esistenti restano a `NULL` e ricadono su
`createdAt`.

Il workflow imposta `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` per anticipare la
migrazione GitHub Actions da Node 20 a Node 24.

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
- se il workflow non gira, l'app fa comunque pulizia opportunistica su calendario, lookup e
  firma ospiti, ma ingoia i propri errori per non far fallire la richiesta utente che la ospita.

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
