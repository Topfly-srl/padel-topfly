import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashManageToken } from "@/lib/manage-token";

// La rinuncia ospite gira solo col database configurato, quindi il percorso si esercita mockando
// prisma, il Graph e la coda after-response. Qui verifichiamo CHI viene avvisato: chi rinuncia
// (che altrimenti resta con l'appuntamento in agenda) e il referente anche quando la prenotazione
// era gia' in attesa firme, caso in cui prima non partiva nessuna mail.
const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  signatureFindUnique: vi.fn(),
  signatureUpdate: vi.fn(),
  bookingUpdate: vi.fn(),
  auditCreate: vi.fn(),
  sendWithdrawalConfirmation: vi.fn(),
  sendOrganizerWithdrew: vi.fn(),
  cancelPendingEvent: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true, timeZone: "Europe/Rome", publicOrigin: "https://padel.test" },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    waiverSignature: { findUnique: h.signatureFindUnique, update: h.signatureUpdate },
    booking: { update: h.bookingUpdate },
    auditLog: { create: h.auditCreate },
    $transaction: h.transaction,
  },
}));

vi.mock("@/lib/graph", () => ({
  sendGuestWaiverConfirmationEmail: vi.fn(),
  sendGuestWithdrawalConfirmationEmail: h.sendWithdrawalConfirmation,
  sendOrganizerGuestWithdrewEmail: h.sendOrganizerWithdrew,
  sendWaiverEmail: vi.fn(),
}));

vi.mock("@/lib/signature-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signature-workflow")>()),
  cancelOutlookEventForPendingBooking: h.cancelPendingEvent,
  runOpportunisticSignatureDeadlines: vi.fn(),
  markBookingConfirmedIfComplete: vi.fn(),
  syncConfirmedBooking: vi.fn(),
}));

vi.mock("@/lib/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    h.afterTasks.push(task);
  },
}));

const { cancelGuestWaiverSignature } = await import("@/lib/waiver-service");

const cancelToken = "token-rinuncia";
const start = new Date("2026-08-20T16:00:00.000Z");

function bookingFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking_1",
    start,
    end: new Date("2026-08-20T17:00:00.000Z"),
    status: "PENDING_SIGNATURES",
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    playerCount: 4,
    waiverRevision: 1,
    outlookEventId: null,
    signatureDeadlineAt: new Date("2026-08-20T10:00:00.000Z"),
    waiverSignatures: [
      { bookingRevision: 1, emailStatus: "SENT", status: "ACTIVE" },
      { bookingRevision: 1, emailStatus: "SENT", status: "ACTIVE" },
      { bookingRevision: 1, emailStatus: "SENT", status: "CANCELED" },
    ],
    ...overrides,
  };
}

function signatureFixture(booking: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "waiver_1",
    bookingId: "booking_1",
    bookingRevision: 1,
    signerName: "Laura Bianchi",
    signerEmail: "laura@example.com",
    signerRole: "GUEST",
    status: "ACTIVE",
    canceledAt: null,
    signedAt: new Date("2026-08-18T09:00:00.000Z"),
    cancelTokenHash: hashManageToken(cancelToken),
    cancelTokenExpiresAt: new Date("2026-08-21T17:00:00.000Z"),
    booking,
    ...overrides,
  };
}

// Il tx del test rispecchia solo cio' che la transazione usa davvero: legge la firma, la marca
// CANCELED e rilegge la booking con le firme aggiornate (signedCount POST-rinuncia).
function transactionFor(booking: Record<string, unknown>, reverted?: Record<string, unknown>) {
  return h.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
    run({
      waiverSignature: {
        findUnique: async () => signatureFixture(booking),
        update: async () => signatureFixture(booking, { status: "CANCELED", canceledAt: new Date() }),
      },
      booking: { update: async () => ({ ...booking, ...reverted }) },
      auditLog: { create: h.auditCreate },
    }),
  );
}

async function flushAfterTasks() {
  const tasks = h.afterTasks.splice(0);
  for (const task of tasks) {
    await task();
  }
}

describe("notifiche rinuncia posto ospite", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-08-19T09:00:00.000Z"));
    h.afterTasks.length = 0;
    h.transaction.mockReset();
    h.signatureFindUnique.mockReset();
    h.auditCreate.mockReset();
    h.sendWithdrawalConfirmation.mockReset();
    h.sendOrganizerWithdrew.mockReset();
    h.cancelPendingEvent.mockReset();

    h.sendWithdrawalConfirmation.mockResolvedValue({ status: "SENT" });
    h.sendOrganizerWithdrew.mockResolvedValue({ status: "SENT" });
    h.cancelPendingEvent.mockImplementation(async (booking: unknown) => booking);
  });

  it("avvisa il referente anche quando la prenotazione era gia' in attesa firme", async () => {
    const booking = bookingFixture({ status: "PENDING_SIGNATURES" });
    transactionFor(booking);
    h.signatureFindUnique.mockResolvedValue(signatureFixture(booking, { status: "CANCELED" }));

    await cancelGuestWaiverSignature("waiver_1", cancelToken);
    await flushAfterTasks();

    expect(h.sendOrganizerWithdrew).toHaveBeenCalledTimes(1);
    const notice = h.sendOrganizerWithdrew.mock.calls[0][0];
    expect(notice.signerName).toBe("Laura Bianchi");
    // Il conto e' quello POST-rinuncia: due firme attive su quattro, non tre.
    expect(notice.signedCount).toBe(2);
    // La finestra era gia' in corso: la deadline citata resta quella corrente, non riparte.
    expect(notice.booking.signatureDeadlineAt).toEqual(new Date("2026-08-20T10:00:00.000Z"));
    // Nessun revert da fare: la prenotazione era gia' pending, l'evento Outlook e' gia' ritirato.
    expect(h.cancelPendingEvent).not.toHaveBeenCalled();
  });

  it("conferma la rinuncia a chi rinuncia, cosi' non gli resta l'appuntamento in agenda", async () => {
    const booking = bookingFixture({ status: "PENDING_SIGNATURES" });
    transactionFor(booking);
    h.signatureFindUnique.mockResolvedValue(signatureFixture(booking, { status: "CANCELED" }));

    await cancelGuestWaiverSignature("waiver_1", cancelToken);
    await flushAfterTasks();

    expect(h.sendWithdrawalConfirmation).toHaveBeenCalledTimes(1);
    const confirmation = h.sendWithdrawalConfirmation.mock.calls[0][0];
    expect(confirmation.signerEmail).toBe("laura@example.com");
    expect(confirmation.signerName).toBe("Laura Bianchi");
    expect(confirmation.booking.id).toBe("booking_1");
  });

  it("dal revert di una confermata avvisa sia chi rinuncia sia il referente, dopo il ritiro evento", async () => {
    const booking = bookingFixture({ status: "CONFIRMED", outlookEventId: "event_1" });
    transactionFor(booking, { status: "PENDING_SIGNATURES" });
    h.signatureFindUnique.mockResolvedValue(signatureFixture(booking, { status: "CANCELED" }));

    await cancelGuestWaiverSignature("waiver_1", cancelToken);
    await flushAfterTasks();

    expect(h.cancelPendingEvent).toHaveBeenCalledTimes(1);
    expect(h.sendWithdrawalConfirmation).toHaveBeenCalledTimes(1);
    expect(h.sendOrganizerWithdrew).toHaveBeenCalledTimes(1);
  });

  it("sulla seconda rinuncia idempotente non riavvisa nessuno", async () => {
    const booking = bookingFixture({ status: "PENDING_SIGNATURES" });
    const alreadyCanceled = signatureFixture(booking, { status: "CANCELED" });
    h.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        waiverSignature: { findUnique: async () => alreadyCanceled, update: h.signatureUpdate },
        booking: { update: h.bookingUpdate },
        auditLog: { create: h.auditCreate },
      }),
    );
    h.signatureFindUnique.mockResolvedValue(alreadyCanceled);

    await cancelGuestWaiverSignature("waiver_1", cancelToken);
    await flushAfterTasks();

    expect(h.sendWithdrawalConfirmation).not.toHaveBeenCalled();
    expect(h.sendOrganizerWithdrew).not.toHaveBeenCalled();
  });
});
