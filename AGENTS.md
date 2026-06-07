# AGENTS.md - Padel TOPFLY

Istruzioni operative per agenti/Codex che lavorano su questo repository.

## Lingua E Stile

- Rispondi in italiano, salvo codice, log o riferimenti tecnici in inglese.
- Sii concreto e operativo: privilegia passi verificabili, comandi e file toccati.
- Per modifiche rischiose o grandi, spiega prima cosa hai capito e il piano.
- Per fix piccoli e chiari, puoi procedere dopo aver letto il contesto rilevante.
- Alla fine riassumi sempre: cosa e' cambiato, verifiche eseguite, cosa resta da fare.

## Contesto Progetto

- App: prenotazione campo padel aziendale TOPFLY.
- Produzione: <https://padel.topflysolutions.com>.
- Hosting: AWS Lightsail, istanza `padel-topfly`, regione `eu-central-1`.
- Server path: `/opt/padel-topfly`.
- Deploy: GitHub Actions workflow `Deploy Production` su push `main`.
- Runtime produzione: Docker Compose con `app`, `postgres`, `caddy`.
- Database produzione: Postgres locale Docker, volume `padel_topfly_pgdata`.
- Auth utenti: nessun login; prenotazione pubblica con nome/cognome + email.
- Auth admin: Microsoft Entra ID solo su `/admin`.
- Graph: Microsoft Outlook calendario/mailbox `padel@topflysolutions.com`.

## Regole Di Sicurezza

- Non leggere, stampare o copiare segreti se non e' indispensabile.
- Non committare mai `.env`, `.env.production`, backup env, chiavi SSH o dump DB.
- Non incollare in chat client secret, token, private key, password o contenuto completo
  di `.env.production`.
- Per Microsoft Graph usare solo i permessi necessari: in V1 serve
  `Calendars.ReadWrite` Application; `Mail.Send` non e' richiesto.
- Prima di modificare produzione, database, env o server remoti, chiedi conferma esplicita.
- Non usare `docker compose down -v` in produzione: elimina il volume Postgres.
- Non eseguire comandi distruttivi (`git reset --hard`, cancellazioni massive, reset DB)
  senza richiesta esplicita.

## Workflow Locale

Comandi standard:

```bash
npm run lint
npm test
npm run build
npm audit --omit=dev
npx prisma validate
```

Per modifiche piccole e mirate, esegui almeno:

```bash
npm run lint
npm test
```

Per modifiche a Prisma/DB/Graph/API, esegui anche:

```bash
npm run build
npx prisma validate
```

Per modifiche UI, verifica anche browser mobile/desktop quando possibile.

## Deploy

- Il deploy automatico parte su push `main` se `PRODUCTION_AUTO_DEPLOY=true`.
- La workflow esegue prima CI completa, crea un dump Postgres in
  `/var/backups/padel-topfly` quando Postgres e' disponibile, fa `git pull --ff-only origin
  main`, rebuilda Docker Compose e controlla <https://padel.topflysolutions.com>.
- Prima di pushare su `main`, assicurati che i check locali rilevanti siano verdi.
- Se il workflow fallisce, leggere log GitHub Actions prima di suggerire comandi sul server.
- Fallback manuale documentato in `docs/production-runbook.md`.

## Microsoft Graph E Email

- Le conferme prenotazione creano/aggiornano eventi Outlook con invito e reminder 1h.
- Le cancellazioni usano la cancellazione nativa Outlook (`event/cancel`) per evitare doppie
  email.
- La mail `Canceled:` e' generata da Outlook: il codice controlla solo il commento testuale.
- Non reintrodurre `/sendMail` per la cancellazione senza discutere il trade-off, perche'
  produce una seconda comunicazione e richiede `Mail.Send`.

## Documentazione

- Aggiorna README e runbook quando cambia produzione, deploy, env, Graph, sicurezza o
  procedura operativa.
- Checklist Bitwarden: `docs/bitwarden-checklist.md`.
- Runbook produzione: `docs/production-runbook.md`.
- Runbook AWS: `docs/aws-deploy.md`.
- Non descrivere funzionalita' solo pianificate come se fossero gia' attive.

## Git

- Non creare commit/push senza richiesta o conferma esplicita dell'utente.
- Se il working tree contiene modifiche non tue, non revertirle.
- Usa commit piccoli e descrittivi.
- Dopo push su `main`, ricordare che puo' partire deploy produzione.

## Bitwarden

- Salvare e mantenere aggiornati gli item indicati in `docs/bitwarden-checklist.md`.
- Se cambia un secret, aggiornare Bitwarden nello stesso momento della modifica.
- Se un secret e' stato incollato in chat/log, considerarlo compromesso e ruotarlo.
