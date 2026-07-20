import { beforeEach, describe, expect, it, vi } from "vitest";

// processSignatureDeadlines gira solo col database configurato (in demo mode esce subito), quindi il
// ramo di auto-annullo si esercita mockando prisma, la coda after-response e retryPrismaTransaction.
// Qui verifichiamo il WIRING del sanitizzatore audit: quando il cron annulla una pending scaduta, i
// campi sensibili (manageTokenHash, guestWaiverTokenHash, outlookEventId, outlookSyncError) NON
// devono finire nel before/after del registro. E' il test che mancava e che avrebbe scoperto il bug.
const h = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: h.findMany,
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    waiverSignature: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: h.auditCreate },
    $transaction: (
      run: (tx: unknown) => Promise<unknown>,
    ) =>
      run({
        booking: { findUnique: h.findUnique, update: h.update },
        auditLog: { create: h.auditCreate },
      }),
  },
}));

vi.mock("@/lib/prisma-retry", () => ({
  retryPrismaTransaction: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/graph", () => ({
  sendOrganizerSignatureReminderEmail: vi.fn(),
  createOutlookEvent: vi.fn(),
  deleteOutlookEvent: vi.fn(),
  sendGuestBookingCanceledEmail: vi.fn(),
  sendOrganizerAutoCanceledEmail: vi.fn(),
  sendOrganizerPendingSignatureEmail: vi.fn(),
}));

vi.mock("@/lib/after-response", () => ({
  runAfterResponse: (task: () => Promise<unknown>) => {
    h.afterTasks.push(task);
  },
}));

const { processSignatureDeadlines } = await import("@/lib/signature-workflow");

const now = new Date("2026-07-15T12:00:00.000Z");

// Una pending scaduta con partita gia' iniziata (start <= now): l'annullo e' silenzioso, ma l'audit
// va scritto lo stesso. La riga trasporta manageTokenHash e compagnia, che il sanitizzatore deve
// togliere. outlookEventId null tiene il ramo silenzioso senza toccare Outlook.
function sensitiveBooking(status: "PENDING_SIGNATURES" | "CANCELED") {
  return {
    id: "booking_1",
    status,
    playerCount: 4,
    waiverRevision: 1,
    organizerEmail: "antony@example.com",
    organizerName: "Antony Buffone",
    start: new Date(now.getTime() - 3_600_000),
    end: new Date(now.getTime() + 1_800_000),
    createdAt: new Date(now.getTime() - 3 * 3_600_000),
    autoCanceledAt: status === "CANCELED" ? now : null,
    outlookEventId: null,
    outlookSyncStatus: "SKIPPED",
    outlookSyncError: "errore tecnico da non salvare",
    manageTokenHash: "hash-manage-da-non-salvare",
    manageTokenExpiresAt: new Date(now.getTime() + 3_600_000),
    guestWaiverTokenHash: "hash-guest-da-non-salvare",
    guestWaiverTokenExpiresAt: new Date(now.getTime() + 3_600_000),
    waiverSignatures: [] as Array<{ bookingRevision: number; status: string }>,
  };
}

async function flushAfterTasks() {
  const tasks = h.afterTasks.splice(0);
  for (const task of tasks) {
    await task();
  }
}

describe("audit auto-annullo firme", () => {
  beforeEach(() => {
    h.afterTasks.length = 0;
    h.auditCreate.mockReset();
    h.findMany.mockReset();
    h.findUnique.mockReset();
    h.update.mockReset();

    // Nessun candidato reminder; una sola pending scaduta da annullare.
    h.findMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve("signatureReminderSentAt" in args.where ? [] : [sensitiveBooking("PENDING_SIGNATURES")]),
    );
    h.findUnique.mockResolvedValue(sensitiveBooking("PENDING_SIGNATURES"));
    h.update.mockResolvedValue(sensitiveBooking("CANCELED"));
  });

  it("annulla la pending scaduta senza scrivere i token nel registro", async () => {
    const result = await processSignatureDeadlines({ now });
    await flushAfterTasks();

    expect(result.canceled).toBe(1);

    const cancelAudit = h.auditCreate.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.action === "BOOKING_AUTO_CANCELED_SIGNATURES");

    expect(cancelAudit).toBeDefined();

    // I campi della blacklist non devono comparire ne' nel before ne' nell'after.
    for (const payload of [cancelAudit.before, cancelAudit.after]) {
      expect(payload).toBeDefined();
      expect(payload).not.toHaveProperty("manageTokenHash");
      expect(payload).not.toHaveProperty("manageTokenExpiresAt");
      expect(payload).not.toHaveProperty("guestWaiverTokenHash");
      expect(payload).not.toHaveProperty("guestWaiverTokenExpiresAt");
      expect(payload).not.toHaveProperty("outlookEventId");
      expect(payload).not.toHaveProperty("outlookSyncError");
    }

    // I campi legittimi restano, cosi' l'audit resta utile.
    expect(cancelAudit.before.status).toBe("PENDING_SIGNATURES");
    expect(cancelAudit.after.status).toBe("CANCELED");
    expect(cancelAudit.after.organizerEmail).toBe("antony@example.com");
  });
});
