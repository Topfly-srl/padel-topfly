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
- Per Microsoft Graph usare solo i permessi necessari: in V1 servono
  `Calendars.ReadWrite` Application e `Mail.Send` Application per inviare i PDF
  degli scarichi responsabilita'. Entrambi vanno limitati alla sola mailbox Padel.
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
DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
```

Per modifiche piccole e mirate, esegui almeno:

```bash
npm run lint
npm test
```

Per modifiche a Prisma/DB/Graph/API, esegui anche:

```bash
npm run build
DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate
```

Per modifiche UI, verifica anche browser mobile/desktop quando possibile.

## Deploy

- Il deploy automatico parte su push `main` se `PRODUCTION_AUTO_DEPLOY=true`.
- Stato corrente: `PRODUCTION_AUTO_DEPLOY=false`, quindi il push su `main` esegue CI e il
  deploy Lightsail va lanciato manualmente se il job deploy risulta skipped.
- La workflow esegue prima CI completa, crea un dump Postgres in
  `/var/backups/padel-topfly` quando Postgres e' disponibile, fa `git pull --ff-only origin
  main`, rebuilda Docker Compose e controlla <https://padel.topflysolutions.com>.
- Prima di pushare su `main`, assicurati che i check locali rilevanti siano verdi.
- Se il workflow fallisce, leggere log GitHub Actions prima di suggerire comandi sul server.
- Fallback manuale documentato in `docs/production-runbook.md`.

### Comandi Utente Per Mandare Online

Se l'utente dice frasi come "manda tutto online", "manda tutto in produzione", "pubblica",
"deploya", "vai live", "metti sul sito ufficiale" o equivalenti, trattalo come conferma
esplicita a completare l'intera procedura di produzione. Non fermarti al commit o al push.

Sequenza richiesta:

1. controlla `git status --short --branch` e assicurati di non includere modifiche non volute;
2. esegui i check locali standard:
   `npm run lint`, `npm test`, `npm run build`,
   `DATABASE_URL='postgresql://padel:padel@localhost:5432/padel_topfly' npx prisma validate`,
   `npm audit --omit=dev`;
3. fai commit descrittivo e push su `main`;
4. controlla `Deploy Production` su GitHub Actions; se il push non esegue il deploy perche'
   `PRODUCTION_AUTO_DEPLOY` e' spento o il job deploy e' skipped, lancia manualmente
   `gh workflow run "Deploy Production" --ref main`;
5. attendi la run con `gh run watch <run-id> --exit-status`;
6. verifica produzione con `curl -I https://padel.topflysolutions.com` e
   `/api/availability`;
7. lancia e verifica `Signature Deadlines` con
   `gh workflow run "Signature Deadlines" --ref main`, poi controlla che il log contenga
   una risposta tipo `{"ok":true,...}` e non `APP_INTERNAL_CRON_SECRET is not configured`;
8. verifica che `POST /api/internal/signature-deadlines` senza token risponda `401` e non
   `503 Cron interno non configurato`;
9. chiudi con un riepilogo: commit, run deploy, run cron, check eseguiti, URL produzione.

Una run schedulata di `Signature Deadlines` puo' fallire con `503` durante un deploy mentre
i container vengono ricreati. Non considerarlo un problema se, dopo il deploy verde, una run
manuale dello stesso workflow passa e restituisce `{"ok":true,...}`.

## Microsoft Graph E Email

- Le conferme prenotazione creano/aggiornano eventi Outlook con invito e reminder 1h.
- Le cancellazioni del referente usano la cancellazione nativa Outlook (`event/cancel`) per
  aggiornare l'invito principale senza doppie email all'organizzatore.
- La mail `Canceled:` e' generata da Outlook: il codice controlla solo il commento testuale.
- Gli ospiti che hanno gia' firmato ricevono invece una mail custom su modifica/cancellazione,
  perche' non sono invitati diretti dell'evento Outlook principale.
- `/sendMail` e' ammesso per i PDF degli scarichi responsabilita' e per le email ospiti
  legate a firma, modifica e cancellazione.

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
