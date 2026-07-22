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
