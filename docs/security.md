# Security Audit - Padel TOPFLY

Audit applicativo e operativo per <https://padel.topflysolutions.com>.

Data ultimo aggiornamento: 2026-06-21.

> **Nota:** questo e' uno **snapshot datato**, non uno stato in tempo reale. Alcuni finding sono
> stati chiusi o superati dopo la data qui sopra (es. SEC-08, SEC-16). Per lo stato operativo
> corrente (deploy, workflow, swap, backup) fa fede sempre
> [`docs/production-runbook.md`](production-runbook.md).

## Executive Summary

La scelta architetturale resta confermata: sito pubblico ma non pubblicizzato, nessun login
per gli utenti normali, admin protetto da Microsoft Entra ID, Graph configurato sulla
mailbox `padel@topflysolutions.com`. La limitazione tenant-side del permesso Application
alla sola mailbox resta da verificare/applicare in Microsoft 365.

Questo audit non e' un penetration test aggressivo. E' un hardening review su codice,
configurazione, deploy e procedure operative. I fix a basso rischio sono stati applicati in
repo; alcune attivita' esterne restano da verificare in Microsoft 365, GitHub, AWS e
Bitwarden.

## Scope

Incluso:

- API Next.js e validazioni server-side;
- Auth admin;
- token gestione prenotazioni;
- rate limit;
- audit log;
- Docker/Caddy;
- GitHub Actions deploy;
- configurazione Microsoft Graph/Outlook;
- runbook e checklist operative.

Non incluso:

- stress test o pentest aggressivo;
- scansioni automatiche contro produzione;
- review completa del tenant Microsoft 365;
- review completa dell'account AWS.

## Stato Fix Applicati

| ID | Severita' | Stato | Area |
| --- | --- | --- | --- |
| SEC-01 | Media | Fix applicato | Security headers e `X-Powered-By` |
| SEC-02 | Alta | Fix applicato | Origin/Referer check sulle mutazioni |
| SEC-03 | Media | Fix applicato | Rate limit IP/email e proxy headers |
| SEC-04 | Media | Fix applicato | Cache API sensibili |
| SEC-05 | Media | Fix applicato | Sanificazione audit log |
| SEC-06 | Media | Fix applicato | Container app non-root |
| SEC-07 | Alta | Verifica manuale richiesta | Graph da limitare alla mailbox |
| SEC-08 | Media | Verifica manuale richiesta | GitHub deploy key e branch protection |
| SEC-09 | Media | Accettato con mitigazioni | SSH aperto per deploy |
| SEC-10 | Media | Parzialmente mitigato | Backup/monitoring |
| SEC-11 | Media | Fix applicato | Backup fuori repo e ignore dump/chiavi |
| SEC-12 | Media | Fix applicato | Retry cancellazione Outlook |
| SEC-13 | Media | Fix applicato | Race blocchi admin/prenotazioni |
| SEC-14 | Media | Fix applicato | Fail-fast env produzione |
| SEC-15 | Media | Fix applicato | Limite dimensione richieste HTTP |
| SEC-16 | Bassa | Fix applicato | Runtime Node GitHub Actions |
| SEC-17 | Media | Fix applicato | Rilevamento produzione robusto (`NODE_ENV`) |
| SEC-18 | Bassa | Fix applicato | Rate limit per-email su firma ospiti |
| SEC-19 | Bassa | Fix applicato | Cancellazione prenotazione transazionale |

## Findings

### SEC-01 - Header sicurezza mancanti e `X-Powered-By` visibile

Severity: Media.

Location:

- `next.config.ts:3`
- `docker/Caddyfile:4`

Evidence:

- prima del fix la risposta runtime esponeva `X-Powered-By: Next.js`;
- Next/Caddy non impostavano CSP, clickjacking defense, nosniff, referrer policy o
  permissions policy in modo verificabile in produzione.

Impact:

- maggiore fingerprinting dello stack;
- minore protezione browser contro clickjacking, plugin/object embedding e alcune classi XSS;
- referrer piu' rumoroso verso domini esterni.

Fix:

- aggiunto `poweredByHeader: false`;
- aggiunti header sicurezza sia in Next sia in Caddy:
  - `Content-Security-Policy`;
  - `X-Content-Type-Options: nosniff`;
  - `X-Frame-Options: DENY`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `Permissions-Policy`.

Note:

- HSTS non e' stato abilitato in questa patch per evitare lockout operativo immediato sul
  sottodominio. Valutarlo dopo alcuni giorni di stabilita'.

### SEC-02 - Mutazioni API protette solo parzialmente da Origin

Severity: Alta.

Location:

- `src/lib/request-guard.ts:82`

Evidence:

- prima del fix, se mancava l'header `Origin`, la richiesta mutating veniva accettata;
- in produzione un endpoint pubblico che crea/modifica/cancella dati deve richiedere
  provenienza same-origin o referer same-origin.

Impact:

- aumenta il rischio di chiamate cross-site o automatizzate che sfruttano browser/utenti;
- il sito non usa login utente, ma gli endpoint pubblici hanno comunque effetti reali.

Fix:

- in produzione, `assertTrustedOrigin` accetta solo:
  - `Origin` uguale a `APP_PUBLIC_ORIGIN`;
  - oppure `Referer` same-origin se `Origin` manca;
- richieste mutating senza `Origin` e senza `Referer` trusted vengono rifiutate con `403`;
- in sviluppo resta permissivo per non rompere test locali.

### SEC-03 - Rate limit solo per IP e IP potenzialmente spoofabile

Severity: Media.

Location:

- `src/lib/request-guard.ts:13`
- `src/app/api/bookings/route.ts:35`
- `docker/Caddyfile:13`

Evidence:

- prima del fix, il rate limit usava il primo valore di `X-Forwarded-For`;
- Caddy non normalizzava gli header `X-Real-IP` e `X-Forwarded-For`;
- la creazione prenotazione non aveva un limite specifico per email.

Impact:

- un client poteva provare a influenzare il bucket IP in alcuni scenari proxy;
- un singolo utente/email poteva fare piu' tentativi ravvicinati passando da IP diversi.

Fix:

- Caddy sovrascrive `X-Real-IP` e `X-Forwarded-For` con il vero client remoto;
- l'app preferisce `X-Real-IP` validato;
- aggiunto bucket rate limit globale `booking:create-email` per email normalizzata;
- il conteggio rate limit persistente usa transazione serializzabile e incremento atomico.

### SEC-04 - API personali/admin senza `Cache-Control: no-store`

Severity: Media.

Location:

- `src/lib/errors.ts:4`

Evidence:

- le API di lookup, admin, manage e availability non forzavano no-store;
- alcune risposte contengono dati personali o amministrativi.

Impact:

- cache intermedie o browser potrebbero conservare risposte non necessarie;
- maggiore rischio di dati vecchi o personali serviti in contesti condivisi.

Fix:

- aggiunto helper `jsonResponse` con `Cache-Control: no-store, max-age=0`;
- applicato alle API e agli errori JSON.

### SEC-05 - Audit log con dati tecnici non necessari

Severity: Media.

Location:

- `src/lib/booking-service.ts:104`

Evidence:

- i payload `before/after` venivano serializzati integralmente;
- campi come `manageTokenHash` e `outlookEventId` non servono nello storico operativo.

Impact:

- esposizione inutile di dati tecnici persistenti;
- maggiore impatto in caso di accesso non autorizzato al DB o ad audit futuri.

Fix:

- aggiunto sanitizer ricorsivo per audit log;
- rimossi dai payload audit:
  - `manageTokenHash`;
  - `manageTokenExpiresAt`;
  - `outlookEventId`;
  - `outlookSyncError`.

### SEC-06 - Container app eseguito come root

Severity: Media.

Location:

- `Dockerfile:32`
- `docker-compose.production.yml:11`

Evidence:

- il container `app` non impostava un utente non-root;
- non erano presenti `no-new-privileges` o `cap_drop`.

Impact:

- in caso di vulnerabilita' runtime, l'attaccante avrebbe piu' privilegi dentro container;
- maggiore superficie di escalation locale.

Fix:

- creato utente non-root `app`;
- il runtime Next gira con `USER app`;
- Compose aggiunge:
  - `security_opt: no-new-privileges:true`;
  - `cap_drop: ALL`.

### SEC-07 - Permesso Graph Application da limitare alla mailbox Padel

Severity: Alta.

Location:

- Microsoft Entra / Exchange Online, fuori dal repo.

Evidence:

- `Calendars.ReadWrite` Application consente accesso calendar application-wide se non
  viene limitato da Exchange;
- Microsoft documenta Application Access Policy per restringere Graph/EWS a mailbox
  specifiche: <https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies>.

Impact:

- se il client secret viene compromesso o abusato, l'app potrebbe accedere a calendari
  o inviare email oltre la mailbox `padel@topflysolutions.com`, se la policy tenant-side
  non e' limitata correttamente.

Fix raccomandato:

- mantenere solo i permessi necessari: `Calendars.ReadWrite` e `Mail.Send` Application;
- usare `Mail.Send` solo per inviare i PDF degli scarichi responsabilita' alla mailbox
  condivisa Padel;
- configurare Exchange Application Access Policy o RBAC for Applications per limitare
  l'app alla mailbox `padel@topflysolutions.com`;
- verificare con `Test-ApplicationAccessPolicy` o test Graph equivalente.

Status:

- da verificare manualmente nel tenant Microsoft 365.

### SEC-08 - Deploy automatico su `main` richiede governance

Severity: Media.

Location:

- GitHub repo `Topfly-srl/padel-topfly`;
- `.github/workflows/deploy-production.yml`.

Evidence:

- stato corrente `PRODUCTION_AUTO_DEPLOY=false`: il push su `main` esegue solo CI e il deploy
  Lightsail va lanciato manualmente (`workflow_dispatch`); l'auto-deploy si attiverebbe solo
  ponendo la variabile a `true`;
- i secrets SSH permettono aggiornamento produzione.

Impact:

- un push non verificato su `main` puo' arrivare in produzione;
- una deploy key esposta consente accesso SSH al server.

Mitigazioni gia' presenti:

- deploy key dedicata;
- known hosts configurato;
- workflow esegue CI prima del deploy;
- workflow crea backup DB fuori repo prima del deploy;
- workflow usa `git pull --ff-only`.

Fix raccomandati:

- abilitare branch protection su `main`;
- richiedere status check `lint/test/build` prima del merge, se si passa a PR;
- ruotare la deploy key se e' mai stata incollata in chat/log;
- mantenere `PRODUCTION_AUTO_DEPLOY=false` (deploy manuale) e alzarlo a `true` solo
  consapevolmente se in futuro si vuole l'auto-deploy da `main`.

Status:

- branch protection e rotazione chiave da verificare manualmente.

### SEC-09 - SSH 22 aperta verso internet

Severity: Media.

Location:

- AWS Lightsail firewall.

Evidence:

- porta `22` aperta per permettere SSH e GitHub Actions.

Impact:

- esposizione a scanning e tentativi brute-force su SSH.

Mitigazioni attuali:

- login via chiave;
- deploy key dedicata;
- istanza non contiene password SSH condivise nel repo.

Trade-off accettato per ora:

- GitHub Actions usa runner dinamici, quindi IP allowlist GitHub e' scomoda e fragile;
- mantenere 22 aperta e compensare con chiavi forti, rotazione e monitoring.

Hardening successivo:

- usare forced-command dedicato per la deploy key;
- valutare SSM Session Manager/VPN o runner self-hosted;
- aggiungere fail2ban se compare traffico anomalo nei log.

### SEC-10 - Backup automatici e alerting non ancora configurati

Severity: Media.

Location:

- AWS Lightsail / server `/opt/padel-topfly`.

Evidence:

- i deploy creano dump pre-deploy in `/var/backups/padel-topfly`;
- non e' ancora documentato un backup automatico periodico indipendente dal deploy.

Impact:

- perdita dati in caso di errore disco, comando distruttivo o corruzione DB;
- assenza di alert se container/app smettono di rispondere.

Fix raccomandati:

- snapshot Lightsail manuale prima del lancio aziendale;
- backup DB schedulato giornaliero/settimanale con retention;
- smoke monitor HTTP su `https://padel.topflysolutions.com`;
- alert via email/Teams in caso di errore.

### SEC-11 - Backup e dump non devono stare nel repository

Severity: Media.

Location:

- `.github/workflows/deploy-production.yml`;
- `.gitignore`;
- `.dockerignore`.

Evidence:

- la prima versione del workflow salvava dump DB in `/opt/padel-topfly/backups`, dentro la
  cartella repository;
- dump, chiavi o backup env dentro il repo possono finire per errore in Git o nel build
  context Docker.

Fix:

- il workflow salva i dump in `/var/backups/padel-topfly`;
- `.gitignore` e `.dockerignore` escludono `backups/`, `*.sql`, `*.dump`, `*.pem`,
  `*.key`, backup `.env*` e `.DS_Store`.

### SEC-12 - Cancellazione Outlook non ritentabile

Severity: Media.

Location:

- `src/lib/booking-service.ts`.

Evidence:

- se una booking era gia' `CANCELED`, il servizio restituiva lo stato senza riprovare la
  cancellazione Outlook anche quando `outlookSyncStatus` era `FAILED`.

Fix:

- se la booking e' gia' cancellata ma ha `outlookEventId` e sync non `SYNCED/SKIPPED`,
  una nuova cancellazione ritenta `deleteOutlookEvent`;
- aggiunto test dedicato.

### SEC-13 - Race tra blocco admin e prenotazione pubblica

Severity: Media.

Location:

- `src/lib/booking-service.ts`.

Evidence:

- le prenotazioni erano gia' create in transazione serializzabile;
- i blocchi admin avevano controllo conflitti e insert nella stessa transazione, ma senza
  isolation level esplicito.

Fix:

- la creazione blocco admin usa transazione `Serializable`, come le prenotazioni.

### SEC-14 - Produzione senza env critiche

Severity: Media.

Location:

- `src/lib/config.ts`.

Evidence:

- prima venivano bloccati `AUTH_DEV_MODE=true` e mancanza `DATABASE_URL`;
- altre env critiche Graph/Auth/admin potevano mancare e generare failure runtime.

Fix:

- in produzione l'app fallisce all'avvio se mancano:
  - `APP_PUBLIC_ORIGIN`;
  - `APP_ADMIN_EMAILS`;
  - env Microsoft Entra admin;
  - env Microsoft Graph;
  - `DATABASE_URL`;
- aggiunto test dedicato.

### SEC-15 - Body HTTP senza limite esplicito in Caddy

Severity: Media.

Location:

- `docker/Caddyfile`.

Evidence:

- gli endpoint pubblici accettano payload piccoli, ma il reverse proxy non aveva un limite
  esplicito alla dimensione del body.

Impact:

- richieste volutamente grandi possono consumare memoria/banda prima che l'app le rifiuti.

Fix:

- Caddy limita il body richiesta a `256KB`, sufficiente per form prenotazioni, lookup token
  e azioni admin attuali.

### SEC-16 - Warning runtime Node 20 nelle GitHub Actions

Severity: Bassa.

Location:

- `.github/workflows/deploy-production.yml`.

Evidence:

- GitHub ha migrato le JavaScript Actions da Node 20 a Node 24.

Impact:

- possibile rumore nei log CI o incompatibilita' futura se il runtime GitHub cambia.

Fix (applicato, superato):

- i workflow usano `actions/checkout@v5` e `actions/setup-node@v5`, gia' sul runtime Node 24:
  il vecchio workaround `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` non e' piu' presente in nessun `.yml`;
- il job CI continua a usare Node 22 per build/test applicativi (`node-version: "22"`).

### SEC-17 - Rilevamento produzione robusto su deploy non-Vercel

Severity: Media.

Location:

- `src/lib/config.ts`, `next.config.ts`.

Evidence:

- la modalita' produzione era rilevata solo da `VERCEL_ENV=production` o `APP_ENV=production`;
- il deploy reale e' su container AWS (`next start`), non Vercel: senza `APP_ENV` impostata
  l'app sarebbe potuta girare in modalita' "development", abilitando `AUTH_DEV_MODE`,
  disattivando gli header di sicurezza e allentando il controllo strict-origin.

Impact:

- una env mancante poteva degradare silenziosamente auth, header e CSRF in produzione.

Fix:

- aggiunto `NODE_ENV=production` (impostato automaticamente da `next start`) come ulteriore
  segnale di produzione in `config.ts` e in `shouldApplySecurityHeaders` di `next.config.ts`;
- conseguenza voluta: il container ora fa fail-fast all'avvio se mancano le env critiche
  (vedi anche SEC-14).

### SEC-18 - Rate limit per-email su firma ospiti

Severity: Bassa.

Location:

- `src/lib/request-guard.ts`, `src/app/api/waivers/[bookingId]/sign/route.ts`.

Evidence:

- la firma ospiti era limitata solo per IP (`waiver:sign`), a differenza della creazione
  prenotazione che ha anche un limite per-email.

Fix:

- aggiunta azione `waiver:sign-email` (8 tentativi / 15 min) applicata sull'email firmataria;
- `normalizedRateScope` ora gestisce un set di azioni email-scoped.

### SEC-19 - Cancellazione prenotazione transazionale

Severity: Bassa.

Location:

- `src/lib/booking-service.ts`.

Evidence:

- `cancelBooking` usava una transazione semplice, senza isolamento `Serializable` ne' retry,
  a differenza di create/update/block.

Fix:

- allineata a `retryPrismaTransaction` + isolamento `Serializable`.

### Nota architetturale - Esecuzione differita delle chiamate Microsoft Graph

Per ridurre la latenza percepita ed evitare falsi errori da timeout di Microsoft Graph,
invio email e sync Outlook vengono ora eseguiti **dopo** la risposta HTTP tramite l'helper
`src/lib/after-response.ts` (basato su `after()` di Next.js). La parte transazionale
(creazione, firma, conteggi) resta sincrona e committata prima della risposta; gli effetti
collaterali differiti persistono comunque il proprio esito (`emailStatus`, `outlookSyncStatus`),
quindi lo stato resta visibile e ritentabile dall'area admin. Affidabile sul runtime a
container long-running in uso (`next start`).

### Nota manutenzione - Indice unique parziale via SQL grezzo

La dedup "una sola firma ATTIVA per email/revisione" e' garantita da un UNIQUE index parziale
(`WHERE status = 'ACTIVE'`) creato in `prisma/migrations`. Prisma non sa esprimere indici
parziali: usare solo `prisma migrate`, mai `prisma db push`, altrimenti l'indice verrebbe
droppato. Nota documentata anche in `prisma/schema.prisma`.

## Verifiche Automatiche Aggiunte

- origin trusted accettato in produzione;
- origin esterno rifiutato;
- mutazione senza origin/referer rifiutata in produzione;
- referer same-origin accettato;
- `X-Real-IP` preferito per rate limit;
- rate limit email globale su creazione prenotazione;
- fail-fast env produzione;
- retry conflitti serializzabili Prisma `P2034`;
- retry cancellazione Outlook fallita;
- audit sanitizer non salva token/hash o dettagli Graph;
- risposte JSON API con `Cache-Control: no-store`;
- health check produzione anche su API con header no-store.

## Checklist Pre-Link Aziendale

### Codice

- [x] `npm run lint` - verificato localmente il 2026-06-08;
- [x] `npm test` - verificato localmente il 2026-06-08;
- [x] `npm run build` - verificato localmente il 2026-06-08;
- [x] `npm audit --omit=dev` - verificato localmente il 2026-06-08;
- [x] `DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate` - verificato localmente il 2026-06-08.

### Produzione

- [ ] deploy GitHub Actions completato;
- [ ] `curl -I https://padel.topflysolutions.com` senza `X-Powered-By`;
- [ ] security headers presenti;
- [ ] `curl -I http://padel.topflysolutions.com` ritorna redirect HTTPS;
- [ ] creazione/modifica/cancellazione prenotazione ok;
- [ ] mail Outlook conferma/cancellazione ok;
- [ ] admin login ok;
- [ ] blocco admin e rimozione blocco ok.

### Microsoft 365

- [ ] `Calendars.ReadWrite` Application con admin consent;
- [ ] `Mail.Send` Application con admin consent;
- [ ] Application Access Policy/RBAC limita accesso alla mailbox Padel;
- [ ] mailbox `padel@topflysolutions.com` confermata come tecnica/condivisa.

### GitHub/AWS/Bitwarden

- [ ] GitHub Actions secrets presenti e non esposti;
- [ ] branch protection valutata su `main`;
- [ ] static IP e DNS documentati;
- [ ] Bitwarden aggiornato con `.env.production`, secret Entra, deploy key e note operative;
- [ ] snapshot/backup iniziale creato prima dell'annuncio aziendale.

## Rischi Residui Accettati In V1

- Sito pubblico senza login utente: e' una scelta UX deliberata; mitigato con origin check,
  rate limit, token gestione e limiti prenotazioni.
- Niente IP allowlist/VPN: scelta deliberata per mantenere accesso semplice da smartphone.
- SSH aperta per deploy: accettato finche' GitHub Actions usa runner dinamici.
- CSP include `unsafe-inline`: compatibilita' Next.js self-hosted; mitigazione parziale,
  senza `unsafe-eval`.
