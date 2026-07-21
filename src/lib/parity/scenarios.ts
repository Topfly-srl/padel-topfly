import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminStats, AvailabilityBlock, AvailabilityBooking, CurrentUser, MyBooking } from "@/lib/types";
import type {
  GuestWaiverCancelContext,
  WaiverContext,
  WaiverEvidence,
  WaiverInput,
} from "@/lib/waiver-service";
import { appConfig } from "@/lib/config";
import { waiverRegulationPath } from "@/lib/waiver-pdf";
import {
  acrossMidnightSlot,
  buildWaiverInput,
  futureSlot,
  hoursFromNowSlot,
  misalignedSlot,
  pastStartedSlot,
} from "@/lib/parity/fixtures";

// HARNESS DI PARITA' (strategia B).
//
// Un flusso "doppio" (demo in-memory vs service Prisma) resta scritto due volte, ma lo stesso
// scenario gira contro entrambi gli attuatori e asserisce gli STESSI esiti attesi. Gli esiti vivono
// in questo unico modulo condiviso: la versione unit lo esegue col driver demo (senza DB), la
// versione *.int.test.ts lo esegue col driver Prisma su Postgres. Poiche' le attese sono scritte una
// volta sola, un cambio di comportamento in produzione che tocchi queste attese rompe SUBITO il lato
// demo (unit) finche' il demo non viene allineato, e viceversa: la divergenza non puo' piu' passare
// inosservata. E' esattamente la rete richiesta per availability/lookup.
//
// Nota: si asseriscono solo i campi che DEVONO coincidere tra i due lati e sono deterministici
// (stato, etichetta del nome, conteggi, presenza/assenza dell'email, ordinamento). Id, token e
// timestamp assoluti differiscono per costruzione e non entrano nel contratto di parita'.

export type ParityCreateInput = {
  start: Date;
  end: Date;
  organizerName: string;
  organizerEmail: string;
  playerCount: number;
  waiver: WaiverInput;
  waiverEvidence?: WaiverEvidence;
  baseUrl?: string;
};

type AvailabilityView = {
  date: string;
  bookings: AvailabilityBooking[];
  blocks: AvailabilityBlock[];
  settings: unknown;
};

// Stesso tipo di viewer accettato da entrambi gli attuatori (demo e Prisma), cosi' il wrapping del
// driver e' diretto senza cast.
type ParityViewer = { role?: CurrentUser["role"] | null } | null;

// Un attuatore concreto del flusso. Le operazioni sono le stesse funzioni pubbliche che l'app usa:
// il driver demo instrada verso demo-store, il driver Prisma verso i service su Postgres.
export type ParityDriver = {
  label: string;
  reset: () => Promise<void> | void;
  // Il driver Prisma lascia lavoro in coda dopo la risposta (email/Graph fire-and-forget): settle
  // aspetta che quelle scritture best-effort atterrino prima del truncate del test successivo. Nel
  // driver demo non c'e' nulla da attendere e resta un no-op.
  settle?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  createBooking: (input: ParityCreateInput) => Promise<MyBooking>;
  getAvailability: (date: string | null, viewer?: ParityViewer) => Promise<AvailabilityView>;
  lookupBookings: (tokens: string[], baseUrl?: string) => Promise<MyBooking[]>;
};

const adminViewer = { role: "ADMIN" as const };

// Chiave giorno in UTC. futureSlot fissa lo start a 18:00 UTC: in Europe/Rome cade nello stesso
// giorno di calendario, quindi la stessa chiave seleziona la giornata sia in demo sia in Prisma.
function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function createInput(overrides: Partial<ParityCreateInput> & Pick<ParityCreateInput, "start" | "end">): ParityCreateInput {
  const organizerName = overrides.organizerName ?? "Mario Rossi";
  const organizerEmail = overrides.organizerEmail ?? "mario.rossi@example.com";
  return {
    organizerName,
    organizerEmail,
    playerCount: overrides.playerCount ?? 4,
    waiver: overrides.waiver ?? buildWaiverInput({ signerName: organizerName, signerEmail: organizerEmail }),
    waiverEvidence: overrides.waiverEvidence ?? {},
    baseUrl: overrides.baseUrl,
    start: overrides.start,
    end: overrides.end,
  };
}

// L'unico vincolo orario rimasto: la partita deve chiudersi entro la mezzanotte del giorno in
// cui inizia (la fascia oraria di apertura e' stata rimossa: il campo e' prenotabile 00-24).
const acrossMidnightMessage = "La prenotazione deve terminare entro la mezzanotte.";

// Il contratto di parita' sugli errori e' il MESSAGGIO esatto, non solo il fatto che si sollevi
// un'eccezione: una divergenza silenziosa spesso e' proprio un messaggio diverso o un errore in
// piu' nel join. Se l'operazione NON viene rifiutata (demo rimasto indietro), caught resta
// undefined e l'asserzione toBeInstanceOf(Error) diventa rossa.
async function expectRejection(promise: Promise<unknown>, expectedMessage: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "l'operazione doveva essere rifiutata").toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(expectedMessage);
}

// Variante che asserisce solo il NUCLEO condiviso del messaggio, non l'uguaglianza esatta. Serve
// dove i due gemelli rifiutano per lo stesso motivo ma con una coda diversa (vedi il blocco admin
// sovrapposto piu' sotto): il nucleo entra nel contratto, la frase di aiuto in coda no.
async function expectRejectionContaining(promise: Promise<unknown>, expectedCore: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "l'operazione doveva essere rifiutata").toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(expectedCore);
}

// Rete di parita' per il flusso di CREAZIONE. Stesso principio di availability/lookup: gli esiti
// (stato, conteggi, presenza del link ospiti, messaggi d'errore) vivono una volta sola qui e
// girano sia contro demoCreateBooking (unit) sia contro createBooking su Postgres (int). Una
// divergenza tra i due gemelli - un tetto controllato in modo diverso, un ordine dei check
// invertito, un messaggio d'errore cambiato da un lato solo - rompe subito uno dei due lati.
export function registerCreateBookingParity(driver: ParityDriver) {
  describe(`parita creazione - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("crea una prenotazione da 4 giocatori in attesa di firme", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(createInput({ ...slot, playerCount: 4 }));

      expect(booking.status).toBe("PENDING_SIGNATURES");
      expect(booking.playerCount).toBe(4);
      expect(booking.waiverSignedCount).toBe(1);
      expect(booking.signatureConfirmedAt).toBeNull();
      expect(booking.signatureDeadlineAt).toBeTruthy();
      expect(booking.manageToken).toBeTruthy();
      // Con piu' di un giocatore nasce anche il link per la firma degli ospiti.
      expect(booking.guestWaiverToken).toBeTruthy();
      expect("organizerEmail" in booking).toBe(false);

      await settle();
    });

    it("conferma subito una prenotazione da un solo giocatore", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(createInput({ ...slot, playerCount: 1 }));

      expect(booking.status).toBe("CONFIRMED");
      expect(booking.playerCount).toBe(1);
      expect(booking.waiverSignedCount).toBe(1);
      expect(booking.signatureConfirmedAt).toBeTruthy();
      expect(booking.manageToken).toBeTruthy();
      // Da solo non ci sono ospiti da far firmare: niente link ospiti.
      expect(booking.guestWaiverToken).toBeUndefined();

      await settle();
    });

    it("rifiuta uno slot gia' occupato con lo stesso messaggio", async () => {
      const slot = futureSlot(1);
      await driver.createBooking(
        createInput({ ...slot, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      // Un altro referente sullo stesso slot: nessuna prenotazione futura a suo nome, quindi
      // l'UNICO errore atteso e' il conflitto di fascia.
      await expectRejection(
        driver.createBooking(
          createInput({ ...slot, organizerName: "Laura Bianchi", organizerEmail: "laura@example.com" }),
        ),
        "Il campo è già prenotato in quella fascia.",
      );

      await settle();
    });

    it("rifiuta una partita che sfora la mezzanotte", async () => {
      const slot = acrossMidnightSlot(1);
      await expectRejection(driver.createBooking(createInput(slot)), acrossMidnightMessage);

      await settle();
    });

    it("rifiuta la terza prenotazione futura attiva", async () => {
      const organizerEmail = "mario@example.com";
      await driver.createBooking(createInput({ ...futureSlot(1), organizerEmail }));
      await driver.createBooking(createInput({ ...futureSlot(2), organizerEmail }));

      // Due future gia' attive: la terza sfonda il tetto, unico errore atteso.
      await expectRejection(
        driver.createBooking(createInput({ ...futureSlot(3), organizerEmail })),
        "Hai già 2 prenotazioni future attive.",
      );

      await settle();
    });

    it("rifiuta un orario disallineato dagli step di 15 minuti", async () => {
      const slot = misalignedSlot(1);
      await expectRejection(
        driver.createBooking(createInput(slot)),
        "Inizio e fine devono essere arrotondati a 15 minuti.",
      );

      await settle();
    });
  });
}

export function registerAvailabilityLookupParity(driver: ParityDriver) {
  describe(`parita availability/lookup - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("crea una prenotazione e la mostra nella giornata pubblica senza esporre l'email", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(createInput(slot));

      expect(booking.status).toBe("PENDING_SIGNATURES");
      expect(booking.organizerName).toBe("Mario Rossi");
      expect(booking.playerCount).toBe(4);
      expect(booking.waiverSignedCount).toBe(1);
      expect(booking.signatureDeadlineAt).toBeTruthy();
      expect(booking.manageToken).toBeTruthy();
      expect("organizerEmail" in booking).toBe(false);

      const availability = await driver.getAvailability(dayKey(slot.start));
      expect(availability.bookings).toHaveLength(1);
      const [view] = availability.bookings;
      expect(view.id).toBe(booking.id);
      expect(view.status).toBe("PENDING_SIGNATURES");
      expect(view.playerCount).toBe(4);
      expect(view.waiverSignedCount).toBe(1);
      expect(view.outlookSyncStatus).toBe("SKIPPED");
      expect(view.signatureDeadlineAt).toBeTruthy();
      expect("organizerEmail" in view).toBe(false);

      await settle();
    });

    it("accorcia il cognome nella giornata pubblica", async () => {
      const slot = futureSlot(1);
      await driver.createBooking(
        createInput({ ...slot, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      const availability = await driver.getAvailability(dayKey(slot.start));
      expect(availability.bookings).toHaveLength(1);
      expect(availability.bookings[0].organizerName).toBe("Mario R.");
      expect(availability.bookings[0].organizerName).not.toBe("Mario Rossi");

      await settle();
    });

    it("mostra il nome intero nella giornata quando la legge un admin", async () => {
      const slot = futureSlot(1);
      await driver.createBooking(
        createInput({ ...slot, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      const availability = await driver.getAvailability(dayKey(slot.start), adminViewer);
      expect(availability.bookings).toHaveLength(1);
      expect(availability.bookings[0].organizerName).toBe("Mario Rossi");

      await settle();
    });

    it("non mostra prenotazioni in una giornata senza slot occupati", async () => {
      const slot = futureSlot(1);
      await driver.createBooking(createInput(slot));

      const emptyDay = await driver.getAvailability(dayKey(futureSlot(5).start));
      expect(emptyDay.bookings).toHaveLength(0);

      await settle();
    });

    it("il lookup del proprietario mostra il nome completo e la prenotazione giusta", async () => {
      const slot = futureSlot(2);
      const booking = await driver.createBooking(
        createInput({ ...slot, organizerName: "Laura Bianchi", organizerEmail: "laura@example.com" }),
      );

      const found = await driver.lookupBookings([booking.manageToken!]);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(booking.id);
      expect(found[0].organizerName).toBe("Laura Bianchi");
      expect(found[0].status).toBe("PENDING_SIGNATURES");
      expect(found[0].manageToken).toBe(booking.manageToken);
      expect("organizerEmail" in found[0]).toBe(false);

      await settle();
    });

    it("il lookup con un token sbagliato non trova nulla", async () => {
      const slot = futureSlot(2);
      await driver.createBooking(createInput(slot));

      await expect(driver.lookupBookings(["token-inesistente"])).resolves.toEqual([]);

      await settle();
    });
  });
}

// Stato di partenza costruito a mano (i seed diretti bypassano la booking policy e restituiscono i
// token in chiaro che la produzione salva solo come hash). Rispecchia demoSeedGuestBooking sul lato
// demo e prisma.booking.create + insertSignature sul lato integrazione: NON e' il flusso sotto
// esame, e' solo il terreno comune su cui i due attuatori devono reagire allo stesso modo.
export type ParitySeedInput = {
  start: Date;
  end: Date;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  signatureDeadlineAt?: Date | null;
  playerCount?: number;
  withGuestSignature?: boolean;
  organizerName?: string;
  organizerEmail?: string;
  guestName?: string;
  guestEmail?: string;
};

export type ParitySeedResult = {
  bookingId: string;
  guestWaiverToken: string;
  signatureId?: string;
  cancelToken?: string;
};

// Stato e scadenza firme letti direttamente dallo store: gemello normalizzato di
// demoReadBookingSnapshot e prisma.booking.findUnique. La scadenza e' in millisecondi epoch cosi'
// il confronto e' relativo ad adesso (i due lati girano a wall-clock diversi: si asseriscono
// distanze, mai istanti assoluti).
export type ParityBookingSnapshot = {
  status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  signatureDeadlineMs: number | null;
};

// Attuatore dei flussi firma (firma ospite + rinuncia posto). Come gli altri driver, le operazioni
// sono le funzioni che l'app usa davvero: il lato demo instrada su demo-store, il lato Prisma sui
// service. seedGuestBooking e readBookingSnapshot sono l'unica parte NON di produzione (setup e
// verifica di stato), implementate a specchio sui due lati.
export type ParitySignatureDriver = {
  label: string;
  reset: () => Promise<void> | void;
  settle?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  createBooking: (input: ParityCreateInput) => Promise<MyBooking>;
  getWaiverContext: (bookingId: string, token: string | null) => Promise<WaiverContext>;
  signGuestWaiver: (
    bookingId: string,
    token: string | null,
    input: WaiverInput,
    evidence: WaiverEvidence,
    baseUrl?: string,
  ) => Promise<WaiverContext>;
  seedGuestBooking: (input: ParitySeedInput) => Promise<ParitySeedResult> | ParitySeedResult;
  getGuestWaiverCancelContext: (
    signatureId: string,
    token: string | null,
  ) => Promise<GuestWaiverCancelContext>;
  cancelGuestWaiverSignature: (
    signatureId: string,
    token: string | null,
  ) => Promise<GuestWaiverCancelContext>;
  readBookingSnapshot: (
    bookingId: string,
  ) => Promise<ParityBookingSnapshot | null> | (ParityBookingSnapshot | null);
};

const parityBaseUrl = "https://parity.example";
const hour = 60 * 60_000;
const minute = 60_000;

function guestWaiver(overrides: { signerName: string; signerEmail: string }): WaiverInput {
  return buildWaiverInput(overrides);
}

// Rete di parita' per la FIRMA OSPITE. La conferma alla firma di chiusura, il rifiuto a finestra
// scaduta e il rifiuto a firme complete vivono qui una volta sola e girano sia contro
// demoSignGuestWaiver (unit) sia contro signGuestWaiver su Postgres (int). Una divergenza tra i due
// gemelli - una conferma mancata, un check saltato, un messaggio d'errore cambiato da un lato solo -
// rompe subito uno dei due lati.
export function registerGuestSignatureParity(driver: ParitySignatureDriver) {
  describe(`parita firma ospite - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("conferma la prenotazione quando l'ospite mette l'ultima firma", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(
        createInput({ ...slot, playerCount: 2, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      expect(booking.status).toBe("PENDING_SIGNATURES");
      expect(booking.waiverSignedCount).toBe(1);
      expect(booking.guestWaiverToken).toBeTruthy();

      const result = await driver.signGuestWaiver(
        booking.id,
        booking.guestWaiverToken!,
        guestWaiver({ signerName: "Laura Bianchi", signerEmail: "laura@example.com" }),
        {},
        parityBaseUrl,
      );

      // Firma di chiusura (2 posti, 2 firme): la prenotazione passa a CONFIRMED e le firme mancanti
      // vanno a zero.
      expect(result.booking.status).toBe("CONFIRMED");
      expect(result.booking.waiverSignedCount).toBe(2);
      expect(result.booking.remainingSignatures).toBe(0);

      await settle();
    });

    it("resta in attesa finche' non arriva l'ultima firma su tre posti", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(
        createInput({ ...slot, playerCount: 3, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      const afterFirst = await driver.signGuestWaiver(
        booking.id,
        booking.guestWaiverToken!,
        guestWaiver({ signerName: "Laura Bianchi", signerEmail: "laura@example.com" }),
        {},
        parityBaseUrl,
      );

      // Penultima firma (2 di 3): ancora in attesa, una firma da raccogliere.
      expect(afterFirst.booking.status).toBe("PENDING_SIGNATURES");
      expect(afterFirst.booking.waiverSignedCount).toBe(2);
      expect(afterFirst.booking.remainingSignatures).toBe(1);

      const afterSecond = await driver.signGuestWaiver(
        booking.id,
        booking.guestWaiverToken!,
        guestWaiver({ signerName: "Gino Verdi", signerEmail: "gino@example.com" }),
        {},
        parityBaseUrl,
      );

      // Firma di chiusura (3 di 3): CONFIRMED.
      expect(afterSecond.booking.status).toBe("CONFIRMED");
      expect(afterSecond.booking.waiverSignedCount).toBe(3);
      expect(afterSecond.booking.remainingSignatures).toBe(0);

      await settle();
    });

    it("rifiuta la firma quando la finestra e' gia' chiusa", async () => {
      const slot = hoursFromNowSlot(2);
      // Pending con la scadenza gia' passata: la pulizia (opportunistica su Prisma, immediata in
      // demo) la annulla prima della firma, quindi l'accesso ospite la trova non piu' attiva. E'
      // il modo in cui una finestra chiusa viene rifiutata, identico sui due lati.
      const seed = await driver.seedGuestBooking({
        ...slot,
        status: "PENDING_SIGNATURES",
        signatureDeadlineAt: new Date(Date.now() - hour),
        playerCount: 2,
      });

      await expectRejection(
        driver.signGuestWaiver(
          seed.bookingId,
          seed.guestWaiverToken,
          guestWaiver({ signerName: "Laura Bianchi", signerEmail: "laura@example.com" }),
          {},
          parityBaseUrl,
        ),
        "La prenotazione non è più attiva.",
      );

      await settle();
    });

    it("rifiuta con 'scadenza passata' una pending gia' completa che scade senza auto-annullo", async () => {
      const slot = hoursFromNowSlot(2);
      // Stato limite: pending con TUTTE le firme gia' presenti (organizzatore + ospite) ma ancora
      // PENDING_SIGNATURES e con la scadenza passata. Ne' il cron ne' la pulizia opportunistica la
      // annullano - una pending gia' completa esce dai cancelCandidates (signature-workflow) e dal
      // ramo di annullo del demo (demoProcessDeadlines) - quindi l'accesso ospite la trova ancora
      // attiva. A rifiutare la firma e' il guardiano della finestra firme (assertSignatureWindowOpen
      // su Prisma, il controllo inline in demoSignGuestWaiver sul demo): e' l'UNICO stato in cui quel
      // ramo e' davvero raggiunto da entrambi gli attuatori, quindi e' qui che si fissa il suo
      // messaggio esatto - deterministico, indipendente dal throttle della pulizia opportunistica
      // (che comunque non annullerebbe una pending completa).
      const seed = await driver.seedGuestBooking({
        ...slot,
        status: "PENDING_SIGNATURES",
        signatureDeadlineAt: new Date(Date.now() - hour),
        playerCount: 2,
        withGuestSignature: true,
      });

      await expectRejection(
        driver.signGuestWaiver(
          seed.bookingId,
          seed.guestWaiverToken,
          guestWaiver({ signerName: "Gino Verdi", signerEmail: "gino@example.com" }),
          {},
          parityBaseUrl,
        ),
        "La scadenza per le firme è passata: la prenotazione non è più confermabile.",
      );

      // Nessun lato l'ha ne' annullata ne' confermata: resta pending, com'era.
      const snapshot = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshot?.status).toBe("PENDING_SIGNATURES");

      await settle();
    });

    it("rifiuta la firma quando i posti sono gia' tutti firmati", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(
        createInput({ ...slot, playerCount: 2, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );

      // Prima firma ospite: chiude i due posti e conferma.
      await driver.signGuestWaiver(
        booking.id,
        booking.guestWaiverToken!,
        guestWaiver({ signerName: "Laura Bianchi", signerEmail: "laura@example.com" }),
        {},
        parityBaseUrl,
      );

      // Un secondo ospite arriva a giochi fatti: le firme risultano gia' complete, stesso rifiuto.
      await expectRejection(
        driver.signGuestWaiver(
          booking.id,
          booking.guestWaiverToken!,
          guestWaiver({ signerName: "Gino Verdi", signerEmail: "gino@example.com" }),
          {},
          parityBaseUrl,
        ),
        "Tutte le firme per questa prenotazione risultano già raccolte.",
      );

      await settle();
    });
  });
}

// Rete di parita' per la LETTURA DELLA PAGINA FIRMA (getWaiverContext). Il contesto che l'ospite
// vede prima di firmare - stato, posti, firme raccolte e mancanti, revisione, versione del documento
// e percorso del regolamento - vive qui una volta sola e gira sia contro demoGetWaiverContext (unit)
// sia contro getWaiverContext su Postgres (int). Il conteggio delle firme si aggiorna dopo la firma
// ospite: la lettura deve rifletterlo allo stesso modo sui due lati.
export function registerWaiverContextParity(driver: ParitySignatureDriver) {
  describe(`parita contesto firma - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("espone il contesto della pagina firma e lo aggiorna dopo la firma ospite", async () => {
      const slot = futureSlot(1);
      const booking = await driver.createBooking(
        createInput({ ...slot, playerCount: 2, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );
      expect(booking.guestWaiverToken).toBeTruthy();

      const before = await driver.getWaiverContext(booking.id, booking.guestWaiverToken!);
      // Prima della firma ospite: pending, la sola firma dell'organizzatore, un posto ancora aperto.
      expect(before.booking.id).toBe(booking.id);
      expect(before.booking.status).toBe("PENDING_SIGNATURES");
      expect(before.booking.playerCount).toBe(2);
      expect(before.booking.waiverSignedCount).toBe(1);
      expect(before.booking.remainingSignatures).toBe(1);
      expect(before.booking.waiverRevision).toBe(1);
      expect(before.booking.organizerName).toBe("Mario Rossi");
      // Versione documento e percorso regolamento: valori condivisi, mai riscritti da un lato solo.
      expect(before.booking.documentVersion).toBe(appConfig.waiver.documentVersion);
      expect(before.booking.regulationUrl).toBe(waiverRegulationPath);

      await driver.signGuestWaiver(
        booking.id,
        booking.guestWaiverToken!,
        guestWaiver({ signerName: "Laura Bianchi", signerEmail: "laura@example.com" }),
        {},
        parityBaseUrl,
      );

      const after = await driver.getWaiverContext(booking.id, booking.guestWaiverToken!);
      // Firma di chiusura: la lettura ora vede CONFIRMED, due firme, nessun posto mancante.
      expect(after.booking.status).toBe("CONFIRMED");
      expect(after.booking.waiverSignedCount).toBe(2);
      expect(after.booking.remainingSignatures).toBe(0);

      await settle();
    });
  });
}

// Rete di parita' per la RINUNCIA AL POSTO. Il revert CONFIRMED -> PENDING con finestra di
// sostituzione, l'idempotenza della doppia rinuncia, la guardia sulla partita gia' iniziata, il
// rifiuto del link errato e il flag canCancel vivono qui una volta sola e girano sia contro
// demoCancelGuestWaiverSignature (unit) sia contro cancelGuestWaiverSignature su Postgres (int).
export function registerGuestCancelParity(driver: ParitySignatureDriver) {
  describe(`parita rinuncia posto - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("riporta la prenotazione in attesa firme con la finestra di sostituzione", async () => {
      // Start tra 3 ore: la finestra di sostituzione (adesso + 2h) domina la scadenza standard, cosi'
      // e' distinguibile da essa.
      const slot = hoursFromNowSlot(3);
      const seed = await driver.seedGuestBooking({ ...slot, status: "CONFIRMED", withGuestSignature: true });

      const before = Date.now();
      const context = await driver.cancelGuestWaiverSignature(seed.signatureId!, seed.cancelToken!);

      expect(context.signature.status).toBe("CANCELED");
      expect(context.canCancel).toBe(false);
      expect(context.booking.status).toBe("PENDING_SIGNATURES");
      // Resta la sola firma dell'organizzatore, con un posto ancora da coprire.
      expect(context.booking.waiverSignedCount).toBe(1);
      expect(context.booking.remainingSignatures).toBe(1);

      // La prenotazione torna in attesa con una finestra di sostituzione (~2 ore da adesso), mai i 30
      // minuti del ramo last minute e mai oltre l'inizio.
      const snapshot = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshot?.status).toBe("PENDING_SIGNATURES");
      expect(snapshot?.signatureDeadlineMs).not.toBeNull();
      const deadlineMs = snapshot!.signatureDeadlineMs!;
      expect(deadlineMs).toBeGreaterThan(before);
      expect(deadlineMs).toBeLessThanOrEqual(slot.start.getTime());
      expect(deadlineMs - before).toBeGreaterThan(2 * hour - 5 * minute);
      expect(deadlineMs - before).toBeLessThan(2 * hour + 5 * minute);

      await settle();
    });

    it("espone canCancel finche' la rinuncia e' possibile e lo chiude dopo", async () => {
      const slot = hoursFromNowSlot(3);
      const seed = await driver.seedGuestBooking({ ...slot, status: "CONFIRMED", withGuestSignature: true });

      // Firma attiva, partita non iniziata, prenotazione viva: si puo' ancora rinunciare.
      const beforeContext = await driver.getGuestWaiverCancelContext(seed.signatureId!, seed.cancelToken!);
      expect(beforeContext.canCancel).toBe(true);
      expect(beforeContext.signature.status).toBe("ACTIVE");

      await driver.cancelGuestWaiverSignature(seed.signatureId!, seed.cancelToken!);

      // Dopo la rinuncia il posto e' gia' andato: canCancel si chiude.
      const afterContext = await driver.getGuestWaiverCancelContext(seed.signatureId!, seed.cancelToken!);
      expect(afterContext.canCancel).toBe(false);
      expect(afterContext.signature.status).toBe("CANCELED");

      await settle();
    });

    it("e' idempotente: una seconda rinuncia con lo stesso link non cambia nulla", async () => {
      const slot = hoursFromNowSlot(3);
      const seed = await driver.seedGuestBooking({ ...slot, status: "CONFIRMED", withGuestSignature: true });

      await driver.cancelGuestWaiverSignature(seed.signatureId!, seed.cancelToken!);
      const deadlineAfterFirst = (await driver.readBookingSnapshot(seed.bookingId))?.signatureDeadlineMs;

      const second = await driver.cancelGuestWaiverSignature(seed.signatureId!, seed.cancelToken!);
      expect(second.signature.status).toBe("CANCELED");
      expect(second.canCancel).toBe(false);
      expect(second.booking.status).toBe("PENDING_SIGNATURES");

      // La seconda rinuncia non riapre la finestra ne' sposta la scadenza.
      const snapshotAfterSecond = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshotAfterSecond?.status).toBe("PENDING_SIGNATURES");
      expect(snapshotAfterSecond?.signatureDeadlineMs).toBe(deadlineAfterFirst);

      await settle();
    });

    it("rifiuta la rinuncia quando la partita e' gia' iniziata", async () => {
      // Start nel passato ma token ancora valido: la partita e' iniziata, la rinuncia va bloccata.
      const slot = pastStartedSlot(1);
      const seed = await driver.seedGuestBooking({ ...slot, status: "CONFIRMED", withGuestSignature: true });

      await expectRejection(
        driver.cancelGuestWaiverSignature(seed.signatureId!, seed.cancelToken!),
        "La partita è già iniziata: non è più possibile rinunciare al posto.",
      );

      // La prenotazione resta CONFIRMED: nessun revert dietro le quinte.
      const snapshot = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshot?.status).toBe("CONFIRMED");

      await settle();
    });

    it("rifiuta la rinuncia con un link errato", async () => {
      const slot = hoursFromNowSlot(3);
      const seed = await driver.seedGuestBooking({ ...slot, status: "CONFIRMED", withGuestSignature: true });

      await expectRejection(
        driver.cancelGuestWaiverSignature(seed.signatureId!, "token-sbagliato"),
        "Link rinuncia posto non valido o scaduto.",
      );

      // Il posto non e' stato toccato: rinuncia ancora possibile col link giusto.
      const context = await driver.getGuestWaiverCancelContext(seed.signatureId!, seed.cancelToken!);
      expect(context.signature.status).toBe("ACTIVE");
      expect(context.canCancel).toBe(true);

      await settle();
    });
  });
}

// --- STAGE D: GESTIONE (update, cancel, elenco admin, blocchi admin) ---
//
// Stessa rete di parita' (strategia B) estesa ai flussi di gestione. Le attese vivono una volta
// sola qui e girano sia contro il demo-store (unit) sia contro i service su Postgres (int).
//
// Tre divergenze demo/prod sono REALI ma NON entrano nel contratto di parita', perche' asserirle
// renderebbe rosso un lato senza che ci sia un comportamento "giusto" condiviso da pinnare (e questo
// stage aggiunge solo test, non tocca l'orchestrazione). Sono documentate qui e asserite solo per la
// parte che coincide davvero:
//   1. Ordine di listBookings: il demo restituisce l'ordine di inserimento, Prisma ordina per start
//      desc. Nessuna UI riordina lato client (la GET /api/bookings non ha consumatori che ordinano) e
//      nessun test esistente fissa l'ordine del demo. Gli scenari confrontano il CONTENUTO per id, mai
//      la posizione.
//   2. Guardia non-admin su listBookings: il demo rifiuta il non-admin con "Serve un account admin.";
//      Prisma delega la guardia alla route (assertAdmin) e la funzione non la ripete. Gli scenari
//      esercitano solo il percorso admin.
//   3. Coda del messaggio sul blocco sovrapposto a una prenotazione: il nucleo "Ci sono prenotazioni
//      attive in questa fascia." coincide, ma Prisma aggiunge " Cancellale o spostale prima." e il demo
//      no. Si asserisce col contains sul nucleo condiviso.
// Queste restano da riconciliare in un eventuale hardening (strategia A) futuro.

// Accesso a un flusso gestito: identico per i due attuatori (DemoAccess e BookingAccess sono la
// stessa forma), cosi' il driver instrada senza cast.
type ParityBookingAccess = {
  adminUser?: CurrentUser | null;
  manageToken?: string | null;
  baseUrl?: string;
};

type ParityUpdateInput = {
  start?: Date;
  end?: Date;
  status?: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  playerCount?: number;
  cancelReason?: string | null;
};

// Admin condiviso dai due lati. Il lato int lo semina davvero come riga User con QUESTO id (le
// foreign key di AdminBlock.createdById e AuditLog.actorId lo esigono); il lato demo lo usa solo
// come identita' in memoria. Un id esplicito e non un cuid casuale cosi' e' lo stesso oggetto su
// entrambi i lati.
export const parityAdminUser: CurrentUser = {
  id: "parity-admin",
  email: "admin.parita@topflysolutions.com",
  name: "Admin Parita",
  role: "ADMIN",
};

// Seed di partenza per i flussi di gestione: una prenotazione con la firma dell'organizzatore gia'
// presente e il manage token IN CHIARO (che il flusso reale salva solo come hash). Rispecchia
// demoSeedManagedBooking sul lato demo e prisma.booking.create + insertSignature sul lato int. NON
// e' il flusso sotto esame: e' il terreno comune su cui i due attuatori devono reagire allo stesso
// modo (serve solo dove la create pubblica non sa costruire lo stato, es. una partita gia' iniziata).
export type ParityManageSeedInput = {
  start: Date;
  end: Date;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  playerCount?: number;
  withGuestSignature?: boolean;
  signatureDeadlineAt?: Date | null;
  organizerName?: string;
  organizerEmail?: string;
};

export type ParityManageSeedResult = {
  bookingId: string;
  manageToken: string;
  guestWaiverToken: string;
};

// Attuatore dei flussi di gestione. Le operazioni sono le funzioni che l'app usa davvero: il lato
// demo instrada su demo-store, il lato Prisma sui service. seedManagedBooking e readBookingSnapshot
// sono l'unica parte NON di produzione (setup e verifica di stato), implementate a specchio.
export type ParityManagementDriver = {
  label: string;
  reset: () => Promise<void> | void;
  settle?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  adminUser: CurrentUser;
  createBooking: (input: ParityCreateInput) => Promise<MyBooking>;
  updateBooking: (
    access: ParityBookingAccess,
    bookingId: string,
    input: ParityUpdateInput,
  ) => Promise<MyBooking>;
  cancelBooking: (
    access: ParityBookingAccess,
    bookingId: string,
    input: { cancelReason?: string | null },
  ) => Promise<MyBooking>;
  listBookings: (user: CurrentUser) => Promise<MyBooking[]>;
  getAdminStats: (now?: Date) => Promise<AdminStats>;
  getAvailability: (date: string | null, viewer?: ParityViewer) => Promise<AvailabilityView>;
  createAdminBlock: (
    user: CurrentUser,
    input: { start: Date; end: Date; reason: string },
  ) => Promise<AvailabilityBlock>;
  deleteAdminBlock: (user: CurrentUser, blockId: string) => Promise<{ id: string }>;
  seedManagedBooking: (
    input: ParityManageSeedInput,
  ) => Promise<ParityManageSeedResult> | ParityManageSeedResult;
  readBookingSnapshot: (
    bookingId: string,
  ) => Promise<ParityBookingSnapshot | null> | (ParityBookingSnapshot | null);
};

// Rete di parita' per l'AGGIORNAMENTO. Lo spostamento con rigenerazione firme, la conferma da
// singolo giocatore con la firma gia' raccolta, la guardia sulla partita iniziata (solo per chi non
// e' admin) e il bypass admin vivono qui una volta sola e girano sia contro demoUpdateBooking (unit)
// sia contro updateBooking su Postgres (int).
export function registerUpdateBookingParity(driver: ParityManagementDriver) {
  describe(`parita aggiornamento - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("spostare la partita rigenera il link ospiti e riazzera le firme", async () => {
      const created = await driver.createBooking(createInput({ ...futureSlot(1), playerCount: 2 }));
      expect(created.status).toBe("PENDING_SIGNATURES");
      expect(created.guestWaiverToken).toBeTruthy();
      const firstGuestToken = created.guestWaiverToken;

      const moved = await driver.updateBooking(
        { manageToken: created.manageToken },
        created.id,
        { ...futureSlot(2) },
      );

      // Nuovo slot con firme fresche: resta in attesa, la firma dell'organizzatore sul vecchio giro
      // non conta piu' (la revisione firme e' avanzata), e nasce un nuovo link ospiti.
      expect(moved.status).toBe("PENDING_SIGNATURES");
      expect(moved.waiverSignedCount).toBe(0);
      expect(moved.signatureConfirmedAt).toBeNull();
      expect(moved.autoCanceledAt).toBeNull();
      expect(moved.signatureDeadlineAt).toBeTruthy();
      expect(moved.guestWaiverToken).toBeTruthy();
      expect(moved.guestWaiverToken).not.toBe(firstGuestToken);

      await settle();
    });

    it("ridurre a un solo giocatore conferma con la firma gia' raccolta", async () => {
      const created = await driver.createBooking(createInput({ ...futureSlot(1), playerCount: 2 }));

      const reduced = await driver.updateBooking(
        { manageToken: created.manageToken },
        created.id,
        { playerCount: 1 },
      );

      // Senza cambio di orario e con la firma dell'organizzatore gia' valida, scendere a un giocatore
      // conferma subito: nessun nuovo link ospiti.
      expect(reduced.status).toBe("CONFIRMED");
      expect(reduced.playerCount).toBe(1);
      expect(reduced.waiverSignedCount).toBe(1);
      expect(reduced.signatureConfirmedAt).toBeTruthy();
      expect(reduced.guestWaiverToken).toBeUndefined();

      await settle();
    });

    it("blocca lo spostamento di una partita gia' iniziata per chi non e' admin", async () => {
      const seed = await driver.seedManagedBooking({
        ...pastStartedSlot(1),
        status: "CONFIRMED",
        playerCount: 2,
        withGuestSignature: true,
      });

      await expectRejection(
        driver.updateBooking({ manageToken: seed.manageToken }, seed.bookingId, { ...futureSlot(1) }),
        "La partita è già iniziata: non è più modificabile.",
      );

      // Nessun cambio dietro le quinte: resta CONFIRMED sullo slot passato.
      const snapshot = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshot?.status).toBe("CONFIRMED");

      await settle();
    });

    it("l'admin puo' spostare anche una partita gia' iniziata", async () => {
      const seed = await driver.seedManagedBooking({
        ...pastStartedSlot(1),
        status: "CONFIRMED",
        playerCount: 2,
        withGuestSignature: true,
      });

      const moved = await driver.updateBooking(
        { adminUser: driver.adminUser },
        seed.bookingId,
        { ...futureSlot(1) },
      );

      // La guardia partita-iniziata vale solo per il referente: l'admin sposta, rigenera le firme e
      // riporta la prenotazione in attesa con un nuovo link ospiti.
      expect(moved.status).toBe("PENDING_SIGNATURES");
      expect(moved.waiverSignedCount).toBe(0);
      expect(moved.guestWaiverToken).toBeTruthy();
      expect(moved.guestWaiverToken).not.toBe(seed.guestWaiverToken);

      const snapshot = await driver.readBookingSnapshot(seed.bookingId);
      expect(snapshot?.status).toBe("PENDING_SIGNATURES");

      await settle();
    });
  });
}

// Rete di parita' per l'ANNULLAMENTO. La causale facoltativa (registrata quando c'e', altrimenti
// nulla), l'idempotenza del secondo annullamento, l'annullamento admin senza link e il rifiuto del
// link errato vivono qui una volta sola e girano sia contro demoCancelBooking (unit) sia contro
// cancelBooking su Postgres (int).
export function registerCancelBookingParity(driver: ParityManagementDriver) {
  describe(`parita annullamento - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("il referente annulla e la causale viene registrata", async () => {
      const created = await driver.createBooking(createInput(futureSlot(1)));

      const canceled = await driver.cancelBooking(
        { manageToken: created.manageToken },
        created.id,
        { cancelReason: "Maltempo" },
      );

      expect(canceled.status).toBe("CANCELED");
      expect(canceled.cancelReason).toBe("Maltempo");

      const snapshot = await driver.readBookingSnapshot(created.id);
      expect(snapshot?.status).toBe("CANCELED");

      await settle();
    });

    it("annulla senza causale: nessun motivo registrato", async () => {
      const created = await driver.createBooking(createInput(futureSlot(1)));

      const canceled = await driver.cancelBooking({ manageToken: created.manageToken }, created.id, {});

      expect(canceled.status).toBe("CANCELED");
      expect(canceled.cancelReason).toBeNull();

      await settle();
    });

    it("un secondo annullamento e' idempotente e non sovrascrive la causale", async () => {
      const created = await driver.createBooking(createInput(futureSlot(1)));
      await driver.cancelBooking({ manageToken: created.manageToken }, created.id, {
        cancelReason: "Imprevisto",
      });

      const again = await driver.cancelBooking({ manageToken: created.manageToken }, created.id, {
        cancelReason: "Altro motivo",
      });

      // La prenotazione era gia' annullata: la seconda causale non entra, resta la prima.
      expect(again.status).toBe("CANCELED");
      expect(again.cancelReason).toBe("Imprevisto");

      await settle();
    });

    it("l'admin annulla la prenotazione di un altro senza link di gestione", async () => {
      const created = await driver.createBooking(
        createInput({ ...futureSlot(1), organizerName: "Laura Bianchi", organizerEmail: "laura@example.com" }),
      );

      const canceled = await driver.cancelBooking({ adminUser: driver.adminUser }, created.id, {});

      expect(canceled.status).toBe("CANCELED");

      await settle();
    });

    it("rifiuta l'annullamento con un link di gestione errato", async () => {
      const created = await driver.createBooking(createInput(futureSlot(1)));

      await expectRejection(
        driver.cancelBooking({ manageToken: "token-sbagliato" }, created.id, {}),
        "Link di gestione non valido o scaduto.",
      );

      // Il link errato non annulla nulla: resta in attesa.
      const snapshot = await driver.readBookingSnapshot(created.id);
      expect(snapshot?.status).not.toBe("CANCELED");

      await settle();
    });
  });
}

// Rete di parita' per l'ELENCO ADMIN. Si confronta il CONTENUTO dell'elenco per id (stato, causale,
// conteggio giocatori, nome intero) e la sua cardinalita', mai la posizione: l'ordine non fa parte
// del contratto (vedi nota in cima a questo blocco).
export function registerListBookingsParity(driver: ParityManagementDriver) {
  describe(`parita elenco admin - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("elenca tutte le prenotazioni col nome intero, lo stato e la causale", async () => {
      const pending = await driver.createBooking(
        createInput({ ...futureSlot(1), playerCount: 4, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );
      const confirmed = await driver.createBooking(
        createInput({ ...futureSlot(2), playerCount: 1, organizerName: "Laura Bianchi", organizerEmail: "laura@example.com" }),
      );
      await driver.cancelBooking({ manageToken: pending.manageToken }, pending.id, {
        cancelReason: "Maltempo",
      });

      const list = await driver.listBookings(driver.adminUser);
      expect(list).toHaveLength(2);

      const canceled = list.find((item) => item.id === pending.id);
      expect(canceled?.status).toBe("CANCELED");
      expect(canceled?.cancelReason).toBe("Maltempo");
      expect(canceled?.playerCount).toBe(4);
      // L'elenco admin mostra il nome per intero, mai accorciato come sul calendario pubblico.
      expect(canceled?.organizerName).toBe("Mario Rossi");

      const active = list.find((item) => item.id === confirmed.id);
      expect(active?.status).toBe("CONFIRMED");
      expect(active?.cancelReason).toBeNull();
      expect(active?.playerCount).toBe(1);
      expect(active?.organizerName).toBe("Laura Bianchi");

      await settle();
    });
  });
}

// Rete di parita' per le STATISTICHE ADMIN. Il calcolo aggregato vive gia' in admin-stats (condiviso
// dai due lati); qui si verifica che l'ORCHESTRAZIONE - quali righe contare e come raggrupparle -
// coincida sui due gemelli. Si asseriscono solo i conteggi robusti (totale, per stato, cancellazioni
// auto/manuali), non le finestre temporali per settimana/ora che dipendono dall'istante e sono gia'
// coperte in admin-stats.test.ts. Invariante: le statistiche restano solo numeri, mai nomi.
export function registerAdminStatsParity(driver: ParityManagementDriver) {
  describe(`parita statistiche admin - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    function statusCount(stats: AdminStats, status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED") {
      return stats.byStatus.find((entry) => entry.status === status)?.count ?? 0;
    }

    it("aggrega totale, stati e cancellazioni allo stesso modo sui due lati", async () => {
      // Una confermata (1 giocatore), una in attesa (4) e una annullata a mano con causale.
      const confirmed = await driver.createBooking(
        createInput({ ...futureSlot(1), playerCount: 1, organizerName: "Laura Bianchi", organizerEmail: "laura@example.com" }),
      );
      const pending = await driver.createBooking(
        createInput({ ...futureSlot(2), playerCount: 4, organizerName: "Mario Rossi", organizerEmail: "mario@example.com" }),
      );
      const toCancel = await driver.createBooking(
        createInput({ ...futureSlot(3), playerCount: 2, organizerName: "Gino Verdi", organizerEmail: "gino@example.com" }),
      );
      await driver.cancelBooking({ manageToken: toCancel.manageToken }, toCancel.id, {
        cancelReason: "Maltempo",
      });

      void confirmed;
      void pending;

      const stats = await driver.getAdminStats();

      // Tre prenotazioni totali, ripartite una per stato.
      expect(stats.totalBookings).toBe(3);
      expect(statusCount(stats, "CONFIRMED")).toBe(1);
      expect(statusCount(stats, "PENDING_SIGNATURES")).toBe(1);
      expect(statusCount(stats, "CANCELED")).toBe(1);

      // Una sola cancellazione, a mano (non automatica), con la causale presente.
      expect(stats.cancellations.total).toBe(1);
      expect(stats.cancellations.auto).toBe(0);
      expect(stats.cancellations.manual).toBe(1);
      expect(stats.cancellations.manualWithoutReason).toBe(0);

      await settle();
    });
  });
}

// Rete di parita' per i BLOCCHI ADMIN. La comparsa del blocco nella giornata, il rifiuto delle
// prenotazioni sovrapposte, la liberazione dopo la cancellazione e il rifiuto del blocco su una
// fascia con prenotazioni attive vivono qui una volta sola e girano sia contro demoCreateAdminBlock/
// demoDeleteAdminBlock (unit) sia contro createAdminBlock/deleteAdminBlock su Postgres (int).
export function registerAdminBlockParity(driver: ParityManagementDriver) {
  describe(`parita blocchi admin - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("crea un blocco, lo mostra nella giornata e blocca le prenotazioni sovrapposte", async () => {
      const slot = futureSlot(1);
      const block = await driver.createAdminBlock(driver.adminUser, {
        start: slot.start,
        end: slot.end,
        reason: "Manutenzione campo",
      });

      expect(block.reason).toBe("Manutenzione campo");
      expect(block.start).toBe(slot.start.toISOString());
      expect(block.end).toBe(slot.end.toISOString());

      const availability = await driver.getAvailability(dayKey(slot.start));
      expect(availability.blocks).toHaveLength(1);
      expect(availability.blocks[0].reason).toBe("Manutenzione campo");
      expect(availability.blocks[0].start).toBe(slot.start.toISOString());
      expect(availability.blocks[0].end).toBe(slot.end.toISOString());

      // Una prenotazione sullo stesso slot ora sbatte contro il blocco, unico errore atteso.
      await expectRejection(
        driver.createBooking(createInput(slot)),
        "Il campo è bloccato dall'admin in quella fascia.",
      );

      await settle();
    });

    it("cancellare il blocco libera di nuovo la giornata", async () => {
      const slot = futureSlot(1);
      const block = await driver.createAdminBlock(driver.adminUser, {
        start: slot.start,
        end: slot.end,
        reason: "Torneo interno",
      });

      const deleted = await driver.deleteAdminBlock(driver.adminUser, block.id);
      expect(deleted.id).toBe(block.id);

      const availability = await driver.getAvailability(dayKey(slot.start));
      expect(availability.blocks).toHaveLength(0);

      // Senza blocco la prenotazione sullo slot torna possibile.
      const booking = await driver.createBooking(createInput(slot));
      expect(booking.status).toBe("PENDING_SIGNATURES");

      await settle();
    });

    it("rifiuta un blocco che si sovrappone a una prenotazione attiva", async () => {
      const slot = futureSlot(1);
      await driver.createBooking(createInput(slot));

      // Il nucleo del messaggio coincide sui due lati; la frase di aiuto in coda differisce (vedi
      // nota in cima a questo blocco) e non entra nel contratto.
      await expectRejectionContaining(
        driver.createAdminBlock(driver.adminUser, {
          start: slot.start,
          end: slot.end,
          reason: "Manutenzione",
        }),
        "Ci sono prenotazioni attive in questa fascia.",
      );

      await settle();
    });
  });
}

// --- STAGE E: PROCESSO SCADENZE FIRME ---
//
// Stessa rete di parita' (strategia B) estesa all'orchestrazione del cron scadenze. Il gemello demo
// (demoProcessDeadlines) gira in memoria, il gemello Prisma (processSignatureDeadlines) su Postgres:
// gli stessi seed deterministici e lo stesso `now` fisso girano contro entrambi e devono produrre
// gli STESSI conteggi (sollecitati, chiusi) e gli STESSI esiti per prenotazione (stato finale,
// sollecito inviato, chiusura automatica). Cosi' le sei regole del cron - sollecito a meta' finestra,
// annullo a scadenza, chiusura anche delle partite gia' iniziate, pending completa che resta pending,
// idempotenza del sollecito - non possono piu' divergere in silenzio tra i due lati.
//
// Fuori dal contratto di parita', perche' asimmetrici per costruzione (asserirli renderebbe rosso un
// lato senza un comportamento "giusto" condiviso):
//   1. Throttle opportunistico: e' un meccanismo SOLO-Prisma (in memoria non risparmierebbe nulla e
//      romperebbe il determinismo, quindi il demo non ce l'ha). Il lato int chiama il cron diretto
//      (processSignatureDeadlines), che per invariante NON passa mai dal throttle: entrambi i lati
//      girano dunque la pulizia senza freni, come qui serve. Il throttle e la sua esclusione dal cron
//      restano coperti a parte in opportunistic-signature-deadlines.test.ts.
//   2. Notifiche e battito: il demo non manda email ne' scrive l'heartbeat (heartbeat solo dalla
//      route cron). La chiusura silenziosa delle partite iniziate qui si osserva come "chiusa lo
//      stesso" (canceled +1, stato CANCELED) su entrambi i lati; la SOPPRESSIONE della mail a
//      posteriori e' un dettaglio Prisma coperto in signature-deadlines.int.test.ts e nei test mail.

export type ParityDeadlineResult = { reminded: number; canceled: number };

export type ParityDeadlineSeedInput = {
  start: Date;
  end?: Date;
  signatureDeadlineAt: Date | null;
  signatureWindowStartedAt?: Date | null;
  signatureReminderSentAt?: Date | null;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  playerCount?: number;
  signedCount?: number;
};

export type ParityDeadlineSeedResult = { bookingId: string };

// Solo cio' che DEVE coincidere tra i due lati dopo il giro del cron: lo stato finale, se il sollecito
// e' partito, se la chiusura e' stata automatica. Mai i timestamp assoluti (i due lati girano a
// wall-clock diversi).
export type ParityDeadlineSnapshot = {
  status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  reminderSent: boolean;
  autoCanceled: boolean;
};

// Attuatore del processo scadenze. seedPendingBooking e readDeadlineSnapshot sono l'unica parte NON
// di produzione (setup e verifica di stato), a specchio sui due lati; processDeadlines e' la funzione
// che l'app usa davvero (demoProcessDeadlines in demo, processSignatureDeadlines su Postgres).
export type ParityDeadlineDriver = {
  label: string;
  reset: () => Promise<void> | void;
  settle?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  seedPendingBooking: (
    input: ParityDeadlineSeedInput,
  ) => Promise<ParityDeadlineSeedResult> | ParityDeadlineSeedResult;
  processDeadlines: (now: Date) => Promise<ParityDeadlineResult> | ParityDeadlineResult;
  readDeadlineSnapshot: (
    bookingId: string,
  ) => Promise<ParityDeadlineSnapshot | null> | (ParityDeadlineSnapshot | null);
};

export function registerDeadlineProcessParity(driver: ParityDeadlineDriver) {
  describe(`parita processo scadenze - ${driver.label}`, () => {
    beforeEach(async () => {
      await driver.reset();
    });

    if (driver.teardown) {
      afterAll(async () => {
        await driver.teardown!();
      });
    }

    const settle = async () => {
      if (driver.settle) await driver.settle();
    };

    it("sollecita a meta' finestra, chiude gli scaduti (incluso deadline == start e partita iniziata) e lascia il resto", async () => {
      const now = new Date("2026-07-20T12:00:00.000Z");

      // Sollecito: deadline entro le prossime 6h, finestra abbastanza vecchia da aver passato la
      // meta' (reminderDueAt <= now), nessuna firma raccolta -> va sollecitato, resta pending.
      const reminder = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 4 * hour),
        signatureDeadlineAt: new Date(now.getTime() + hour),
        signatureWindowStartedAt: new Date(now.getTime() - 10 * hour),
        playerCount: 2,
      });

      // Last minute: deadline == start, entrambi appena passati e partita gia' iniziata. DEVE essere
      // chiusa lo stesso (con "scaduta E non iniziata" resterebbe pending per sempre); la chiusura e'
      // silenziosa lato Prisma, ma qui si osserva solo che entrambi la annullano.
      const deadlineEqualsStart = await driver.seedPendingBooking({
        start: new Date(now.getTime() - minute),
        signatureDeadlineAt: new Date(now.getTime() - minute),
        playerCount: 2,
      });

      // Scaduta ma non ancora iniziata: chiusa normalmente.
      const expiredNotStarted = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 2 * hour),
        signatureDeadlineAt: new Date(now.getTime() - hour),
        playerCount: 2,
      });

      // Deadline passata ma firme gia' complete: pending che resta pending, ne' chiusa ne' sollecitata.
      const fullySigned = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 2 * hour),
        signatureDeadlineAt: new Date(now.getTime() - 30 * minute),
        playerCount: 1,
        signedCount: 1,
      });

      // Pending con deadline lontana: ne' sollecito ne' chiusura.
      const futurePending = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 3 * 24 * hour),
        signatureDeadlineAt: new Date(now.getTime() + 2 * 24 * hour),
        playerCount: 2,
      });

      // Gia' confermata: intoccabile.
      const confirmed = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 2 * hour),
        signatureDeadlineAt: null,
        status: "CONFIRMED",
        playerCount: 1,
        signedCount: 1,
      });

      const result = await driver.processDeadlines(now);
      expect(result.reminded).toBe(1);
      expect(result.canceled).toBe(2);

      const remindedSnap = await driver.readDeadlineSnapshot(reminder.bookingId);
      expect(remindedSnap?.status).toBe("PENDING_SIGNATURES");
      expect(remindedSnap?.reminderSent).toBe(true);
      expect(remindedSnap?.autoCanceled).toBe(false);

      const deadlineEqualsStartSnap = await driver.readDeadlineSnapshot(deadlineEqualsStart.bookingId);
      expect(deadlineEqualsStartSnap?.status).toBe("CANCELED");
      expect(deadlineEqualsStartSnap?.autoCanceled).toBe(true);

      const expiredSnap = await driver.readDeadlineSnapshot(expiredNotStarted.bookingId);
      expect(expiredSnap?.status).toBe("CANCELED");
      expect(expiredSnap?.autoCanceled).toBe(true);

      const fullySignedSnap = await driver.readDeadlineSnapshot(fullySigned.bookingId);
      expect(fullySignedSnap?.status).toBe("PENDING_SIGNATURES");
      expect(fullySignedSnap?.autoCanceled).toBe(false);
      expect(fullySignedSnap?.reminderSent).toBe(false);

      const futureSnap = await driver.readDeadlineSnapshot(futurePending.bookingId);
      expect(futureSnap?.status).toBe("PENDING_SIGNATURES");
      expect(futureSnap?.reminderSent).toBe(false);
      expect(futureSnap?.autoCanceled).toBe(false);

      const confirmedSnap = await driver.readDeadlineSnapshot(confirmed.bookingId);
      expect(confirmedSnap?.status).toBe("CONFIRMED");

      await settle();
    });

    it("non risollecita chi ha gia' ricevuto il promemoria", async () => {
      const now = new Date("2026-07-20T12:00:00.000Z");

      const alreadyReminded = await driver.seedPendingBooking({
        start: new Date(now.getTime() + 4 * hour),
        signatureDeadlineAt: new Date(now.getTime() + hour),
        signatureWindowStartedAt: new Date(now.getTime() - 10 * hour),
        signatureReminderSentAt: new Date(now.getTime() - 30 * minute),
        playerCount: 2,
      });

      const result = await driver.processDeadlines(now);
      expect(result.reminded).toBe(0);
      expect(result.canceled).toBe(0);

      const snapshot = await driver.readDeadlineSnapshot(alreadyReminded.bookingId);
      expect(snapshot?.status).toBe("PENDING_SIGNATURES");
      expect(snapshot?.reminderSent).toBe(true);
      expect(snapshot?.autoCanceled).toBe(false);

      await settle();
    });
  });
}
