# Revisione indipendente Codex — ciclo 15–21 luglio 2026

## Sommario esecutivo

La revisione dei 46 commit ha individuato 7 finding bloccanti (2 corretti, 5 residui) e 6 minori (2 corretti, 4 residui); nessun finding puramente cosmetico.
La flakiness nasceva da task `runAfterResponse` ancora attivi quando il test successivo troncava il Postgres condiviso: la barriera ora attende i task reali, senza timeout empirici o retry ciechi.
Sul branch finale risultano verdi 15/15 run d'integrazione consecutive (10 normali, 5 con 8 worker CPU), oltre a unit, ESLint, TypeScript, build, Prisma validate e audit dipendenze; nessun push o deploy è stato eseguito.

## Perimetro e metodo

- Branch di lavoro: `codex/review-luglio`, creato da `d6b37c0`.
- Perimetro storico: `381ebb4..d6b37c0`; esaminati `git log --stat`, i diff dei commit e il codice finale.
- Aree controllate: policy firme e cancellazioni, concorrenza Prisma, side effect Graph, email, privacy, auth/token/rate limit, demo/Prisma parity, workflow operativi, timezone/DST e UI desktop/mobile.
- Database locale: Postgres 16 nel container `padel-gate-pg`.
- Nessun file segreto è stato letto o riportato; nessun workflow GitHub, push, deploy o modifica di produzione è stato eseguito.

## Findings bloccanti

### B1 — L'audit persistente contiene dati personali

- **Gravità:** bloccante, residuo.
- **File:riga:** `src/lib/booking-service.ts:182`, `src/lib/booking-service.ts:186`, `src/lib/audit-sanitizer.ts:7`, `src/components/admin/admin-audit-section.tsx:53`, `src/lib/signature-cancel-audit.test.ts:149`.
- **Scenario:** Mario annulla una prenotazione. L'audit salva `actorEmail` e gli snapshot completi `before/after`; il sanitizzatore rimuove token e dati Outlook, ma conserva `organizerName`, `organizerEmail` e la causale libera. Il test rende esplicita la conservazione dell'email. Quei dati restano fino alla retention configurata di 24 mesi, in contrasto con l'invariante «audit senza dati personali».
- **Fix proposto:** sostituire la blacklist con payload audit in allowlist per azione (stato, conteggi, motivo normalizzato non libero), registrare un actor tecnico/pseudonimo e migrare o redigere le righe esistenti. La modifica richiede una decisione sul valore probatorio dell'audit e una migrazione dati, quindi non è stata applicata come fix a rischio zero.

### B2 — Update e annullamento concorrenti possono riattivare una prenotazione annullata

- **Gravità:** bloccante, residuo.
- **File:riga:** `src/lib/booking-service.ts:703`, `src/lib/booking-service.ts:723`, `src/lib/booking-service.ts:767`, `src/lib/booking-service.ts:782`, `src/lib/booking-service.ts:898`, `src/lib/booking-service.ts:917`.
- **Scenario:** due richieste leggono la stessa prenotazione attiva; A la annulla, B la sposta o cambia i giocatori. Le decisioni di B (`nextStatus`, firme, notifiche e snapshot audit) sono calcolate prima della transazione. Se A committa prima che B aggiorni — oppure B ritenta dopo un conflitto 40001 — B riusa lo snapshot stantio e fa un `update` solo per id, potendo riportare lo stato a `PENDING_SIGNATURES`/`CONFIRMED`. Partono inoltre side effect incompatibili di annullamento e aggiornamento.
- **Fix proposto:** rileggere e autorizzare la riga dentro ogni tentativo serializable, calcolare lì tutte le transizioni e usare un CAS/versione o un predicato sullo stato atteso. Aggiungere un test d'integrazione deterministico update-vs-cancel. Non applicato perché cambia una transazione centrale e richiede allineamento demo/parity.

### B3 — Il browser interpreta gli slot nel fuso del dispositivo, non in Europe/Rome

- **Gravità:** bloccante, residuo.
- **File:riga:** `src/lib/booking-ui.ts:16`, `src/lib/booking-ui.ts:20`, `src/lib/timeline-slots.ts:78`, `src/components/booking-checkout.tsx:59`, `src/components/booking-checkout.tsx:63`.
- **Scenario:** un dipendente con laptop impostato su UTC seleziona `2026-07-22 18:00`. `new Date("2026-07-22T18:00:00")` crea 18:00 UTC e la richiesta serializzata rappresenta le 20:00 a Roma; riepilogo, overlap e prenotazione effettiva slittano di due ore. Nei cambi DST la stessa costruzione può anche normalizzare un'ora inesistente o scegliere un offset ambiguo.
- **Fix proposto:** convertire sempre data/ora di parete con `fromZonedTime(..., appConfig.timeZone)`, passare il fuso configurato ai componenti client e formattare con `timeZone` esplicito. Servono test con browser in UTC/America e casi DST; non applicato come patch locale perché attraversa calendario, checkout e admin.

### B4 — I side effect Graph non hanno controllo di versione né idempotenza di creazione

- **Gravità:** bloccante, residuo.
- **File:riga:** `src/lib/signature-workflow.ts:223`, `src/lib/signature-workflow.ts:237`, `src/lib/booking-service.ts:199`, `src/lib/booking-service.ts:203`, `src/lib/graph.ts:1106`, `src/lib/graph.ts:1115`, `src/lib/graph.ts:1135`.
- **Scenario 1:** l'ultima firma avvia un `POST /calendar/events`; prima della risposta il referente annulla. Il task tardivo aggiorna la prenotazione solo per id con l'event id appena creato, mentre il task di annullamento può aver visto `outlookEventId=null`: resta un evento Outlook attivo su una prenotazione annullata.
- **Scenario 2:** Graph accetta il POST ma la risposta si perde. Il DB registra `FAILED`; il retry, non avendo un event id né un `transactionId` deterministico, crea un secondo evento.
- **Fix proposto:** outbox persistente con versione/revision della prenotazione, update DB condizionale sullo stato/revision attesi e compensazione degli eventi creati su stato stantio; usare l'idempotenza Graph disponibile con chiave deterministica. Non applicato perché richiede un protocollo di side effect e migrazione, non una correzione isolata.

### B5 — La finestra di sostituzione supera le due ore previste

- **Gravità:** bloccante, residuo.
- **File:riga:** `src/lib/signature-workflow.ts:100`, `src/lib/signature-workflow.ts:103`, `src/lib/signature-workflow.ts:107`, `src/lib/signature-workflow.test.ts:163`.
- **Scenario:** un ospite rinuncia tre giorni prima della partita. La funzione confronta la deadline standard con `now + 2h` e restituisce la più generosa; nel caso coperto dal test concede molto più di due ore. L'invariante consegnato richiede invece «2h dalla rinuncia».
- **Fix proposto:** restituire `min(now + 2h, start)` e aggiornare scenario condiviso, demo, Prisma e test di reminder/cron. Non applicato perché il codice e il test documentano deliberatamente il comportamento opposto: va risolta esplicitamente la contraddizione di prodotto.

### B6 — Il workflow diagnostico stampava PII nei log GitHub

- **Gravità:** bloccante, corretto.
- **File:riga:** `.github/workflows/diagnose-production.yml:71`, `.github/workflows/diagnose-production.yml:73`, `.github/workflows/diagnose-production.yml:75`.
- **Scenario:** una diagnosi manuale stampava righe Audit/Booking con identificatori, actor email, timestamp e causale libera nei log conservati da GitHub Actions. Un motivo come «annullo per Mario Rossi» diventava un dato personale duplicato fuori dal database.
- **Fix applicato:** query sostituite con soli conteggi aggregati giornalieri, mantenendo il necessario `< /dev/null`. Commit `257166d`.

### B7 — Il cron poteva inviare una cancellazione Outlook dopo l'inizio

- **Gravità:** bloccante, corretto.
- **File:riga:** `src/lib/signature-workflow.ts:467`, `src/lib/signature-workflow.ts:475`, `src/lib/signature-workflow.ts:508`.
- **Scenario:** una pending già iniziata conservava per anomalia un `outlookEventId`. Il cron evitava le email custom, ma il task successivo chiamava comunque `event/cancel`, che genera la mail nativa Outlook a partita iniziata e viola l'invariante di chiusura silenziosa.
- **Fix applicato:** per `start <= now` la transazione scollega l'event id, marca la sync `SKIPPED` e non accoda alcun side effect Graph/email. Aggiunto test con evento residuo e asserzione di zero chiamate Graph. Commit `95fda50`.

## Findings minori

### M1 — Il teardown d'integrazione usava un timeout invece dello stato reale dei task

- **Gravità:** minore, corretto; causa della flakiness.
- **File:riga:** `src/lib/after-response.ts:3`, `src/lib/after-response.ts:34`, `src/lib/after-response.ts:45`, `src/lib/int-test-support.ts:31`.
- **Scenario:** `runAfterResponse` fuori da una request avviava il task in fire-and-forget; `settle()` aspettava 150 ms e poi il test successivo eseguiva `TRUNCATE`. Sotto carico la sync Graph simulata superava il timeout e provava `booking.update` sulla riga appena rimossa, contaminando il file successivo o producendo errori Prisma tardivi.
- **Fix applicato:** registro dei Promise reali e barriera drenante, incluso il caso in cui un task ne accodi un altro. Nessun retry aggiunto e nessuna serializzazione globale della suite. Test unitario con Promise controllato. Commit `621eadf`.

### M2 — Il cron firme risultava verde senza il secret

- **Gravità:** minore, corretto.
- **File:riga:** `.github/workflows/signature-deadlines.yml:29`.
- **Scenario:** secret assente: il workflow usciva con successo senza chiamare la produzione, mascherando un cron operativo disabilitato.
- **Fix applicato:** messaggio su stderr ed `exit 1`; il job ora fallisce in modo osservabile. Commit `bb2aad6`.

### M3 — La configurazione staging di esempio non può avviarsi

- **Gravità:** minore, residuo.
- **File:riga:** `.env.staging.example:7`, `.env.staging.example:17`, `src/lib/config.ts:10`, `src/lib/config.ts:49`.
- **Scenario:** l'esempio combina `APP_ENV=production`, `AUTH_DEV_MODE=true` e credenziali Entra/Graph vuote. Con `next start`, il fail-fast di produzione rifiuta immediatamente auth dev e poi i secret mancanti: lo staging isolato descritto dal file non parte.
- **Fix proposto:** introdurre un ambiente `staging` esplicito che mantenga `NODE_ENV=production`, strict-origin e header di produzione ma consenta auth dev/Graph disattivato solo su loopback. Un primo fix esplorativo (`eb98ed6`) è stato annullato integralmente da `08a0df5`, perché il prompt vieta di modificare qualunque `.env*`; lo stato finale dei file è identico a `d6b37c0`.

### M4 — `prisma db push` produce un database test diverso da produzione

- **Gravità:** minore, residuo.
- **File:riga:** `prisma/schema.prisma:142`, `prisma/schema.prisma:146`, `prisma/migrations/20260619090000_active_waiver_signature_unique_email/migration.sql:3`.
- **Scenario:** il bootstrap indicato nel prompt con `prisma db push` dichiara lo schema «in sync» ma non crea l'unique index parziale sulle firme ACTIVE, che Prisma schema non sa rappresentare. Due firme concorrenti con la stessa email possono quindi comportarsi diversamente nel test locale rispetto alla produzione e non esercitare il catch P2002 previsto.
- **Fix proposto:** bootstrap di un DB vuoto esclusivamente con `prisma migrate deploy` e preflight della suite che verifichi l'index. Per questa review l'indice è stato riallineato solo nel container locale di test con l'SQL idempotente della migration; nessuna modifica DB remota o sorgente è stata fatta.

### M5 — Due retry admin simultanei possono inviare la stessa email due volte

- **Gravità:** minore, residuo.
- **File:riga:** `src/lib/waiver-service.ts:1090`, `src/lib/waiver-service.ts:1095`, `src/lib/waiver-service.ts:1105`, `src/lib/waiver-service.ts:1115`.
- **Scenario:** due admin cliccano «reinvio» sulla stessa firma FAILED. Entrambe le richieste leggono le stesse leg ritentabili prima che una cambi stato e inviano entrambe la copia archivio/firmatario; il controllo «non reinviare la leg già riuscita» non è atomico.
- **Fix proposto:** claim transazionale per leg (`FAILED -> PENDING`) con versione/attempt id, oppure tabella outbox con chiave idempotente. Aggiungere test concorrente. Non applicato per evitare una modifica di schema/protocollo in una patch di review.

### M6 — Le statistiche admin divergono tra demo e Prisma e l'audit non è coperto dalla parity

- **Gravità:** minore, residuo.
- **File:riga:** `src/lib/demo-store.ts:641`, `src/lib/demo-store.ts:659`, `src/lib/booking-service.ts:1058`, `src/lib/booking-service.ts:1120`, `src/lib/parity/scenarios.ts:865`, `src/lib/parity/scenarios.ts:1183`.
- **Scenario:** su una pending scaduta, la sola apertura delle statistiche chiama `demoProcessDeadlines(now)` nel demo e la auto-annulla; `getAdminStats` Prisma è read-only e la lascia pending. Lo scenario condiviso usa solo deadline future e non intercetta la divergenza. Inoltre `demoGetAdminAudit` è una funzione pubblica gemella con paginazione propria ma non compare in alcun driver parity.
- **Fix proposto:** decidere se le stats devono essere read-only su entrambi i lati (preferibile) o processare deadline su entrambi; aggiungere scenario expired-pending. Aggiungere un driver parity per filtro, ordine e paginazione audit. Non applicato perché cambia la semantica operativa di una pagina admin.

Non sono emersi finding cosmetici separati.

## Confutazioni tentate

- **Prisma 7 / 40001:** verificato che il classificatore degli errori serializable usa la forma emessa dall'adapter Prisma 7; non va ripristinato il solo controllo P2034.
- **Griglia full-day:** `bookingTimeOptions` produce 96 slot da 00:00 a 23:45; 23:45 + 15 minuti è accettato e mostrato come 23:45–00:00. La fine oltre mezzanotte resta bloccata con il messaggio richiesto.
- **Cancellazione dopo l'inizio:** la cancellazione dell'intera prenotazione resta consentita; sono bloccati spostamento utente e rinuncia ospite, come richiesto.
- **Privacy calendario pubblico:** l'API pubblica espone l'etichetta abbreviata e non email; il nome completo è selezionato solo nel percorso admin. Non trovato un bypass di ruolo.
- **Email Graph:** shell unica, nessuna immagine, palette rossa, nessun tono verde e oggetti con data. Gli invii archivio/firmatario hanno stati separati.
- **Email esterne:** il contesto iniziale poteva suggerire un blocco del dominio, ma il README dichiara esplicitamente che le email non aziendali sono ammesse con warning; non è stato aperto un finding.
- **Auth e token:** le rotte admin passano dal controllo ADMIN; le rotte pubbliche sensibili verificano token hash/scadenza e applicano rate limit. Non è emerso un bypass concreto nel perimetro.
- **Workflow diagnostico:** il pattern `< /dev/null` è stato preservato; rimuoverlo avrebbe fatto consumare a `psql` il resto dell'heredoc.
- **UI responsive:** testata in browser a 1440 px e 390×844 senza overflow orizzontale. La prima cattura full-page mobile risultava compressa per un artefatto della cattura; lo screenshot del viewport e le misure DOM hanno confutato un bug CSS. In demo senza env locale Auth.js segnala correttamente il secret mancante, senza impedire le pagine pubbliche.

## Diagnosi della flakiness

### Evidenza prima del fix

La suite usa lo stesso database tra scenari e chiama `TRUNCATE ... CASCADE` nel teardown. I side effect Graph/email vengono avviati da `runAfterResponse`; fuori dalla request Next il fallback li avviava senza restituire un handle. `settle(150)` era quindi solo una speranza temporale.

Nel loop pre-fix:

- 12/12 run normali hanno completato le 46 asserzioni, ma le run 1 e 9 hanno stampato dopo il test un errore Prisma da `syncConfirmedBooking` (`signature-workflow.ts:237`): tentativo di aggiornare una Booking già rimossa dal teardown;
- 6/6 run con 8 processi CPU concorrenti hanno completato le asserzioni, in 42–46 secondi;
- il campione non ha prodotto un'asserzione rossa, ma ha riprodotto due volte la scrittura tardiva che spiega sia il fallimento intermittente singolo sia l'amplificazione sotto build/carico.

### Correzione

`runAfterResponse` registra ogni Promise effettivamente avviato in un Set. `waitForAfterResponseTasks()` drena il Set e ricontrolla finché è vuoto; `settle()` attende questa barriera prima del reset. Il comportamento runtime resta best-effort e le eccezioni accessorie continuano a non propagarsi alla risposta utente.

### Prova di stabilità finale

Sul commit finale precedente al solo report:

- run 01–10 normali: **10/10 verdi**, durate 18, 20, 18, 23, 19, 19, 20, 20, 21, 21 s;
- run 11–15 con **8 processi `yes >/dev/null` concorrenti**: **5/5 verdi**, durate 45, 43, 46, 47, 45 s;
- totale consecutivo: **15/15 run, 690/690 test d'integrazione**, nessun errore Prisma tardivo osservato;
- i processi di carico sono stati terminati dal trap della prova.

## Esito suite prima e dopo

| Verifica | Prima delle modifiche | Dopo le modifiche |
| --- | --- | --- |
| Unit | 34 file, 255/255 test verdi, 7,90 s | 35 file, 256/256 test verdi, 12,34 s |
| Integrazione singola | 9 file, 46/46 verdi, 30,37 s | inclusa nella prova 15×: ogni run 46/46 verde |
| Stabilità integrazione | 12 run normali + 6 sotto carico: asserzioni verdi, ma 2 errori Prisma tardivi | 15/15 consecutive verdi; 10 normali + 5 sotto 8 worker CPU |
| TypeScript | `npx tsc --noEmit` verde | verde |
| ESLint | `npx eslint .` verde | `npm run lint` verde |
| Build | `npm run build` verde, Next.js 16.2.10 | verde, Next.js 16.2.10 |
| Prisma schema | valido | `prisma validate` verde |
| Dipendenze runtime | non campionato separatamente | `npm audit --omit=dev`: 0 vulnerabilità |
| Browser | non campionato | desktop/mobile verdi; 96 slot e checkout 23:45–00:00 verificati |

## Commit creati

1. `621eadf` — `Drain after-response tasks in integration tests`
2. `257166d` — `Remove personal data from production diagnostics`
3. `bb2aad6` — `Fail when the signature cron secret is missing`
4. `eb98ed6` — `Allow the isolated staging runtime to start` (esplorativo, integralmente annullato)
5. `95fda50` — `Keep expired started bookings silent`
6. `08a0df5` — `Restore the untouched staging configuration` (annulla integralmente `eb98ed6`)
7. Commit documentale che contiene questo report.

Il file `PROMPT-CODEX.md` è rimasto non tracciato e non è incluso in alcun commit.
