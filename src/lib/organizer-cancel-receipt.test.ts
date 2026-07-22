import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashManageToken } from "@/lib/manage-token";

// cancelBooking gira solo col database configurato, quindi il percorso si esercita mockando
// prisma, il Graph e la coda after-response. Qui verifichiamo che il referente riceva SEMPRE una
// ricevuta del proprio annullamento (prima la riceveva solo se annullava un admin diverso da lui,
// mentre i suoi ospiti venivano avvisati regolarmente) e che il testo distingua l'attore senza
// mai nominare l'admin.
const h = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  signatureFindMany: vi.fn(),
  transaction: vi.fn(),
  auditCreate: vi.fn(),
  sendOrganizerCanceled: vi.fn(),
  sendGuestCanceled: vi.fn(),
  deleteEvent: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true, timeZone: "Europe/Rome", publicOrigin: "https://padel.test" },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: h.bookingFindUnique, update: h.bookingUpdate },
    waiverSignature: { findMany: h.signatureFindMany },
    auditLog: { create: h.auditCreate },
    $transaction: h.transaction,
  },
}));

vi.mock("@/lib/graph", () => ({
  createOutlookEvent: vi.fn(),
  deleteOutlookEvent: h.deleteEvent,
  sendGuestBookingCanceledEmail: h.sendGuestCanceled,
  sendGuestBookingUpdatedEmail: vi.fn(),
  sendOrganizerBookingCanceledEmail: h.sendOrganizerCanceled,
  updateOutlookEvent: vi.fn(),
}));

vi.mock("@/lib/signature-workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/signature-workflow")>()),
  runOpportunisticSignatureDeadlines: vi.fn(),
  cancelOutlookEventForPendingBooking: vi.fn(),
  markBookingConfirmedIfComplete: vi.fn(),
  syncConfirmedBooking: vi.fn(),
  sendPendingSignatureNotice: vi.fn(),
}));

vi.mock("@/lib/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    h.afterTasks.push(task);
  },
}));

const { cancelBooking } = await import("@/lib/booking-service");

const manageToken = "token-gestione";

function bookingFixture(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-18T09:00:00.000Z");

  return {
    id: "booking_1",
    start: new Date("2026-08-20T16:00:00.000Z"),
    end: new Date("2026-08-20T17:00:00.000Z"),
    status: "PENDING_SIGNATURES",
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    manageTokenHash: hashManageToken(manageToken),
    manageTokenExpiresAt: new Date("2026-08-21T17:00:00.000Z"),
    outlookEventId: null,
    outlookSyncStatus: "SKIPPED",
    outlookSyncError: null,
    playerCount: 4,
    waiverRevision: 1,
    signatureDeadlineAt: new Date("2026-08-20T10:00:00.000Z"),
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    waiverSignatures: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function flushAfterTasks() {
  const tasks = h.afterTasks.splice(0);
  for (const task of tasks) {
    await task();
  }
}

describe("ricevuta annullamento al referente", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-08-19T09:00:00.000Z"));
    h.afterTasks.length = 0;
    h.bookingFindUnique.mockReset();
    h.bookingUpdate.mockReset();
    h.signatureFindMany.mockReset();
    h.transaction.mockReset();
    h.auditCreate.mockReset();
    h.sendOrganizerCanceled.mockReset();
    h.sendGuestCanceled.mockReset();
    h.deleteEvent.mockReset();

    h.signatureFindMany.mockResolvedValue([]);
    h.sendOrganizerCanceled.mockResolvedValue({ status: "SENT" });
    h.sendGuestCanceled.mockResolvedValue({ status: "SENT" });
    h.deleteEvent.mockResolvedValue({ status: "SKIPPED" });
    h.bookingFindUnique.mockResolvedValue(bookingFixture());
    h.bookingUpdate.mockResolvedValue(bookingFixture({ status: "CANCELED" }));
    // Il tx deve rispecchiare cio' che cancelBooking usa davvero: la guardia updateMany (vince
    // il primo annullamento), la rilettura findUniqueOrThrow e la lista ospiti da avvisare.
    // Niente `update` nel tx: se un refactor reintroducesse la scrittura cieca per id, il test
    // deve diventare rosso, non accontentarla in silenzio.
    h.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        booking: {
          updateMany: async () => ({ count: 1 }),
          findUniqueOrThrow: async () => bookingFixture({ status: "CANCELED" }),
        },
        waiverSignature: { findMany: h.signatureFindMany },
        auditLog: { create: h.auditCreate },
      }),
    );
  });

  it("manda la ricevuta al referente che annulla dal link di gestione", async () => {
    await cancelBooking({ manageToken }, "booking_1");
    await flushAfterTasks();

    expect(h.sendOrganizerCanceled).toHaveBeenCalledTimes(1);
    expect(h.sendOrganizerCanceled.mock.calls[0][0].actor).toBe("organizer");
  });

  it("manda la ricevuta all'admin che annulla la propria prenotazione, come a se stesso", async () => {
    await cancelBooking(
      { adminUser: { id: "u1", role: "ADMIN", email: "mario@topfly.it", name: "Mario Rossi" } },
      "booking_1",
    );
    await flushAfterTasks();

    expect(h.sendOrganizerCanceled).toHaveBeenCalledTimes(1);
    expect(h.sendOrganizerCanceled.mock.calls[0][0].actor).toBe("organizer");
  });

  it("attribuisce all'amministrazione l'annullamento fatto da un admin diverso dal referente", async () => {
    await cancelBooking(
      { adminUser: { id: "u2", role: "ADMIN", email: "stefano@topfly.it", name: "Stefano" } },
      "booking_1",
    );
    await flushAfterTasks();

    expect(h.sendOrganizerCanceled).toHaveBeenCalledTimes(1);
    expect(h.sendOrganizerCanceled.mock.calls[0][0].actor).toBe("admin");
  });

  it("avvisa il referente anche quando aveva ospiti gia' avvisati per conto loro", async () => {
    h.signatureFindMany.mockResolvedValue([
      { signerName: "Laura Bianchi", signerEmail: "laura@example.com" },
    ]);

    await cancelBooking({ manageToken }, "booking_1");
    await flushAfterTasks();

    expect(h.sendGuestCanceled).toHaveBeenCalledTimes(1);
    expect(h.sendOrganizerCanceled).toHaveBeenCalledTimes(1);
  });

  it("sul secondo annullamento idempotente non rimanda la ricevuta", async () => {
    h.bookingFindUnique.mockResolvedValue(bookingFixture({ status: "CANCELED" }));

    await cancelBooking({ manageToken }, "booking_1");
    await flushAfterTasks();

    expect(h.sendOrganizerCanceled).not.toHaveBeenCalled();
  });
});
