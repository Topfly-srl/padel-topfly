import { beforeEach, describe, expect, it, vi } from "vitest";

// createBooking gira solo col database configurato, quindi il percorso si esercita mockando
// prisma, il Graph e la coda after-response. Qui verifichiamo che alla creazione il referente
// riceva UNA mail sola (prima ne partivano due: l'avviso attesa firme e la copia del suo
// scarico) e che l'archivio legale resti un invio separato con i suoi esiti.
const h = vi.hoisted(() => ({
  bookingCount: vi.fn(),
  bookingFindMany: vi.fn(),
  blockFindMany: vi.fn(),
  bookingCreate: vi.fn(),
  bookingFindUnique: vi.fn(),
  signatureFindUnique: vi.fn(),
  signatureUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  createWaiverSignature: vi.fn(),
  markConfirmed: vi.fn(),
  syncConfirmed: vi.fn(),
  sendWaiverEmail: vi.fn(),
  sendOrganizerPending: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
  mailOrder: [] as string[],
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true, timeZone: "Europe/Rome", publicOrigin: "https://padel.test" },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique },
    waiverSignature: { findUnique: h.signatureFindUnique, update: h.signatureUpdate },
    auditLog: { create: h.auditCreate },
    $transaction: h.transaction,
  },
}));

vi.mock("@/lib/graph", () => ({
  createOutlookEvent: vi.fn(),
  deleteOutlookEvent: vi.fn(),
  sendGuestBookingCanceledEmail: vi.fn(),
  sendGuestBookingUpdatedEmail: vi.fn(),
  sendGuestWaiverConfirmationEmail: vi.fn(),
  sendGuestWithdrawalConfirmationEmail: vi.fn(),
  sendOrganizerBookingCanceledEmail: vi.fn(),
  sendOrganizerGuestWithdrewEmail: vi.fn(),
  sendOrganizerPendingSignatureEmail: h.sendOrganizerPending,
  sendWaiverEmail: h.sendWaiverEmail,
  updateOutlookEvent: vi.fn(),
}));

vi.mock("@/lib/signature-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signature-workflow")>()),
  runOpportunisticSignatureDeadlines: vi.fn(),
  cancelOutlookEventForPendingBooking: vi.fn(),
  markBookingConfirmedIfComplete: h.markConfirmed,
  syncConfirmedBooking: h.syncConfirmed,
}));

// La generazione del PDF e' gia' coperta altrove ed e' lo step lento: qui serve solo che la
// firma esista con i suoi byte.
vi.mock("@/lib/waiver-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/waiver-service")>()),
  createWaiverSignature: h.createWaiverSignature,
}));

vi.mock("@/lib/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    h.afterTasks.push(task);
  },
}));

const { createBooking } = await import("@/lib/booking-service");

const signedAt = new Date("2026-08-19T09:00:00.000Z");
const pdfBytes = Buffer.from([37, 80, 68, 70]);

function bookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking_1",
    start: new Date("2026-08-20T16:00:00.000Z"),
    end: new Date("2026-08-20T17:00:00.000Z"),
    status: "PENDING_SIGNATURES",
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    manageTokenHash: "hash",
    manageTokenExpiresAt: new Date("2026-08-21T17:00:00.000Z"),
    outlookEventId: null,
    outlookSyncStatus: "SKIPPED",
    outlookSyncError: null,
    playerCount: 4,
    waiverRevision: 1,
    signatureDeadlineAt: new Date("2026-08-20T12:00:00.000Z"),
    signatureWindowStartedAt: signedAt,
    signatureReminderSentAt: null,
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    guestWaiverTokenHash: null,
    guestWaiverTokenExpiresAt: null,
    createdAt: signedAt,
    updatedAt: signedAt,
    organizerId: null,
    ...overrides,
  };
}

function createInput(playerCount: number) {
  return {
    start: new Date("2026-08-20T16:00:00.000Z"),
    end: new Date("2026-08-20T17:00:00.000Z"),
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    playerCount,
    waiver: {} as never,
    baseUrl: "https://padel.test",
  };
}

async function flushAfterTasks() {
  const tasks = h.afterTasks.splice(0);
  for (const task of tasks) {
    await task();
  }
}

describe("mail al referente alla creazione", () => {
  beforeEach(() => {
    vi.setSystemTime(signedAt);
    h.afterTasks.length = 0;
    h.mailOrder.length = 0;
    vi.clearAllMocks();

    h.bookingCount.mockResolvedValue(0);
    h.bookingFindMany.mockResolvedValue([]);
    h.blockFindMany.mockResolvedValue([]);
    h.bookingCreate.mockImplementation(async () => bookingFixture());
    h.bookingFindUnique.mockResolvedValue(bookingFixture({ waiverSignatures: [] }));
    h.signatureUpdate.mockResolvedValue({});
    h.signatureFindUnique.mockResolvedValue({
      id: "waiver_1",
      bookingId: "booking_1",
      signerRole: "ORGANIZER",
      signerName: "Mario Rossi",
      signerEmail: "mario@topfly.it",
      signedAt,
      pdfBytes,
      booking: bookingFixture(),
    });
    h.createWaiverSignature.mockResolvedValue({
      id: "waiver_1",
      signerEmail: "mario@topfly.it",
      signatureImageSha256: null,
      pdfSha256: "sha",
    });
    h.markConfirmed.mockImplementation(async (_tx: unknown, booking: unknown) => ({
      confirmed: false,
      booking,
    }));
    h.syncConfirmed.mockResolvedValue(undefined);
    h.sendWaiverEmail.mockImplementation(async () => {
      h.mailOrder.push("archivio");
      return { archive: { status: "SENT" } };
    });
    h.sendOrganizerPending.mockImplementation(async () => {
      h.mailOrder.push("referente");
      return { status: "SENT" };
    });
    h.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        booking: { count: h.bookingCount, findMany: h.bookingFindMany, create: h.bookingCreate },
        adminBlock: { findMany: h.blockFindMany },
        auditLog: { create: h.auditCreate },
      }),
    );
  });

  it("allega il PDF all'avviso attesa firme invece di mandarne una copia a parte", async () => {
    await createBooking(createInput(4));
    await flushAfterTasks();

    // L'archivio legale resta il suo invio, ma senza la leg "signer": quella mail ora e'
    // l'allegato dell'avviso, e mandarla di nuovo sarebbe il doppione che stiamo togliendo.
    expect(h.sendWaiverEmail).toHaveBeenCalledTimes(1);
    expect(h.sendWaiverEmail.mock.calls[0][0].legs).toEqual(["archive"]);

    expect(h.sendOrganizerPending).toHaveBeenCalledTimes(1);
    const notice = h.sendOrganizerPending.mock.calls[0][0];
    expect(notice.booking.organizerEmail).toBe("mario@topfly.it");
    expect(notice.pdfBytes).toBe(pdfBytes);
    expect(notice.filename).toContain("scarico-responsabilita-padel-2026-08-19-mario-rossi");
    expect(notice.guestWaiverUrl).toContain("/waiver/booking_1?token=");
  });

  it("registra l'esito dell'avviso nelle colonne della copia al referente", async () => {
    h.sendOrganizerPending.mockResolvedValue({ status: "FAILED", error: "mailbox piena" });

    await createBooking(createInput(4));
    await flushAfterTasks();

    // L'avviso ha assorbito la copia al referente: il suo esito va nelle stesse colonne,
    // altrimenti l'area admin e il reinvio non sanno che il PDF non e' mai arrivato.
    const update = h.signatureUpdate.mock.calls.at(-1)![0];
    expect(update.where).toEqual({ id: "waiver_1" });
    expect(update.data.signerEmailStatus).toBe("FAILED");
    expect(update.data.signerEmailError).toBe("mailbox piena");
    expect(update.data.signerEmailSentAt).toBeNull();
  });

  it("segna la copia al referente come inviata quando l'avviso col PDF parte", async () => {
    await createBooking(createInput(4));
    await flushAfterTasks();

    const update = h.signatureUpdate.mock.calls.at(-1)![0];
    expect(update.data.signerEmailStatus).toBe("SENT");
    expect(update.data.signerEmailError).toBeNull();
    expect(update.data.signerEmailSentAt).toBeInstanceOf(Date);
  });

  it("manda l'archivio prima dell'avviso, non in ordine casuale", async () => {
    await createBooking(createInput(4));
    await flushAfterTasks();

    // Le due mail partivano da due code indipendenti: l'ordine di arrivo non era garantito.
    expect(h.mailOrder).toEqual(["archivio", "referente"]);
  });

  it("manda l'avviso attesa firme anche se la scrittura dell'esito archivio esplode", async () => {
    // Gli errori Graph diventano FAILED e non risalgono, ma la findUnique che non trova la riga
    // (404) e la update su un blip del DB si': sono le due eccezioni vere del percorso archivio.
    h.signatureUpdate.mockRejectedValueOnce(new Error("connessione persa"));

    await createBooking(createInput(4));
    await flushAfterTasks();

    // Nello stesso task senza catch, quell'eccezione si portava via l'avviso: il referente
    // restava senza link firma ospiti (il token e' salvato solo come hash, l'avviso e' l'unica
    // copia utilizzabile), nessuno poteva firmare e la partita moriva alla scadenza in silenzio.
    expect(h.sendOrganizerPending).toHaveBeenCalledTimes(1);
    expect(h.mailOrder).toEqual(["archivio", "referente"]);
  });

  it("manda al referente la copia del PDF quando la prenotazione nasce confermata", async () => {
    const confirmed = bookingFixture({ status: "CONFIRMED", playerCount: 1 });
    h.bookingCreate.mockResolvedValue(bookingFixture({ playerCount: 1 }));
    h.bookingFindUnique.mockResolvedValue({ ...confirmed, waiverSignatures: [] });
    h.markConfirmed.mockResolvedValue({ confirmed: true, booking: confirmed });

    await createBooking(createInput(1));
    await flushAfterTasks();

    // Con un solo giocatore la firma completa subito le firme: l'avviso attesa firme non parte
    // e al suo posto arriva l'invito di calendario, che non controlliamo. Senza mail in cui
    // allegarlo, il PDF ha bisogno della sua copia come sempre.
    expect(h.sendOrganizerPending).not.toHaveBeenCalled();
    expect(h.sendWaiverEmail).toHaveBeenCalledTimes(1);
    expect(h.sendWaiverEmail.mock.calls[0][0].legs).toBeUndefined();
    expect(h.sendWaiverEmail.mock.calls[0][0].signerCopyEmail).toBe("mario@topfly.it");
    expect(h.syncConfirmed).toHaveBeenCalledTimes(1);
  });
});
