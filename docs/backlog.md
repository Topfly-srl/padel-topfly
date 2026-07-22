# Backlog / Miglioramenti futuri

Cose decise ma rimandate: non sono bug, l'app funziona. Da riprendere quando c'è tempo.

## Unire le due mail per azione in una sola

**Stato:** rimandato su richiesta del committente (22/07/2026) — "per ora lasciamo che
arrivano due mail". Nessuna urgenza.

**Situazione attuale.** Per ogni azione l'organizzatore riceve DUE mail, che sono cose diverse
(non doppioni):

- **Prenotazione** → (1) mail "Scarico di responsabilità" con il PDF firmato in allegato;
  (2) invito calendario nativo ("Campo prenotato", il cui corpo è la conferma "Prenotazione
  campo confermata"), generato da `createOutlookEvent` con `POST /calendar/events`.
- **Annullamento** → (1) mail rossa "Prenotazione annullata" (`sendOrganizerBookingCanceledEmail`);
  (2) cancellazione calendario nativa ("Canceled: …") generata da `deleteOutlookEvent` con
  `POST /events/{id}/cancel`.

La seconda mail di ogni coppia è l'**avviso di calendario**: è ciò che fa comparire/sparire
l'evento dal calendario Outlook/Google del destinatario. Oggetto e formato li impone il client
di posta (per questo la disdetta ha l'oggetto in inglese "Canceled:").

**Obiettivo (opzione scelta a voce ma non ancora implementata): "una sola sempre, fatta bene".**
Far sì che la nostra mail brandizzata (rossa, in italiano, col PDF alla creazione) porti dentro
di sé anche l'evento di calendario, così ne parte UNA per azione.

**Approccio tecnico da valutare.** Smettere di creare l'evento con l'API nativa di Graph e
allegare invece un file **`.ics`** alla nostra `sendMail`:
- creazione → `.ics` con `METHOD:REQUEST`;
- annullamento → `.ics` con `METHOD:CANCEL`, stesso `UID` e `SEQUENCE` incrementato.

**Compromessi da tenere presenti (perché non è un fix banale):**
- si perde l'integrazione nativa più ricca dell'invito Outlook (pulsanti RSVP Sì/No/Forse,
  promemoria automatico "1 ora prima" impostato da `reminderMinutesBeforeStart`);
- il tracciamento lato app oggi si appoggia a `outlookEventId` + `outlookSyncStatus`: con l'`.ics`
  quel modello va ripensato (UID stabile al posto dell'event id restituito da Graph);
- va rifatto il collaudo end-to-end su Outlook E Gmail (creazione + annullamento), come già fatto
  il 22/07 — vedi la nota "Sistema email VERIFICATO" negli appunti di progetto.

**File coinvolti:** `src/lib/graph.ts` (`createOutlookEvent`, `deleteOutlookEvent`, `eventPayload`,
le `sendMail`), `src/lib/booking-service.ts` e `src/lib/signature-workflow.ts` (i punti che
salgono/scendono `outlookEventId` e chiamano la sync), più i test di parità.

**Nota:** la copia d'archivio dello scarico verso la Direzione (`APP_WAIVER_RECIPIENT_EMAIL`,
padel@topflysolutions.com) è una mail a un destinatario DIVERSO e resta comunque separata: non
rientra in questa unificazione.

## Spunti residui dalla revisione Codex (non bloccanti)

Salvati qui dal report `REVIEW-CODEX.md` (poi eliminato) per non perderli. Sono migliorie di
robustezza, non bug che si vedono in uso normale. I finding bloccanti B2/B3/B4 e i minori
B6/B7/M1/M2 erano già stati corretti; B1/B5 riclassificati come non-difetti.

- **Staging di esempio non avviabile (era M3).** `.env.staging.example` mescola
  `APP_ENV=production`, `AUTH_DEV_MODE=true` e credenziali Entra/Graph vuote: con `next start`
  il fail-fast di produzione rifiuta auth dev e poi i secret mancanti, quindi lo staging isolato
  non parte così com'è. Idea: introdurre un ambiente `staging` esplicito che tenga header e
  strict-origin di produzione ma consenta auth dev / Graph spento solo su loopback. File:
  `.env.staging.example`, `src/lib/config.ts`.
- **Bootstrap DB di test con `prisma db push` diverge dalla produzione (era M4).** `db push`
  dichiara lo schema "in sync" ma NON crea l'unique index parziale sulle firme ACTIVE (Prisma
  schema non lo sa rappresentare, vive in una migration SQL grezza). Il DB di test locale può
  quindi comportarsi diversamente dalla produzione sul catch delle firme duplicate. Regola:
  bootstrappare un DB vuoto solo con `prisma migrate deploy`, mai `db push`; eventualmente un
  preflight della suite che verifichi l'esistenza dell'indice. File:
  `prisma/migrations/20260619090000_active_waiver_signature_unique_email/`.
- **Due retry admin simultanei possono inviare la stessa email due volte (era M5).** Due admin
  che cliccano "reinvia" sulla stessa firma FAILED leggono le stesse leg ritentabili prima che
  una cambi stato: il controllo "non reinviare la leg già riuscita" non è atomico. Idea: claim
  transazionale per leg (`FAILED -> PENDING`) con attempt id, o outbox con chiave idempotente.
  File: `src/lib/waiver-service.ts` (intorno al reinvio manuale).
- **Stats admin: demo vs Prisma non del tutto allineate + audit non coperto dalla parità (era
  M6).** Aprendo le statistiche, il demo processa le deadline (`demoProcessDeadlines`) e
  auto-annulla una pending scaduta, mentre `getAdminStats` su Prisma è read-only e la lascia
  pending: divergenza non intercettata dagli scenari di parità (che usano solo deadline future).
  Inoltre `demoGetAdminAudit` non compare in nessun driver di parità. Idea: decidere se le stats
  devono essere read-only su entrambi i lati (preferibile), aggiungere uno scenario
  expired-pending e un driver di parità per l'audit. File: `src/lib/demo-store.ts`,
  `src/lib/booking-service.ts` (`getAdminStats`), `src/lib/parity/scenarios.ts`.
