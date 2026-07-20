import { beforeEach, describe, expect, it, vi } from "vitest";

// La potatura dell'audit viaggia col battito del cron: gira una sola volta al giorno, taglia le
// righe piu' vecchie della finestra di ritenzione e riporta quante ne ha rimosse nel risultato
// del giro. Qui verifichiamo il wiring col database mockato: purge solo col flag heartbeat, cutoff
// calcolato su APP_AUDIT_RETENTION_MONTHS, e nessun secondo taglio quando il battito di oggi c'e'
// gia'.
const h = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  auditFindFirst: vi.fn(),
  auditDeleteMany: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true, timeZone: "Europe/Rome", auditRetentionMonths: 24 },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: h.findMany,
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    auditLog: { create: h.auditCreate, findFirst: h.auditFindFirst, deleteMany: h.auditDeleteMany },
    $transaction: vi.fn(),
  },
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
  runAfterResponse: () => {},
}));

const { processSignatureDeadlines } = await import("@/lib/signature-workflow");

const now = new Date("2026-07-20T12:00:00.000Z");

describe("potatura audit nel giro del cron", () => {
  beforeEach(() => {
    h.auditCreate.mockReset();
    h.auditFindFirst.mockReset();
    h.auditDeleteMany.mockReset();
    h.findMany.mockReset();

    // Giornata tranquilla: nessuna pending da sollecitare o annullare.
    h.findMany.mockResolvedValue([]);
    h.auditDeleteMany.mockResolvedValue({ count: 7 });
  });

  it("pota solo col flag heartbeat, al primo battito del giorno, e riporta il conteggio", async () => {
    h.auditFindFirst.mockResolvedValue(null);

    const result = await processSignatureDeadlines({ now, heartbeat: true });

    expect(h.auditDeleteMany).toHaveBeenCalledTimes(1);
    expect(result.auditPruned).toBe(7);
  });

  it("usa il cutoff giusto: righe piu' vecchie della finestra di ritenzione", async () => {
    h.auditFindFirst.mockResolvedValue(null);

    await processSignatureDeadlines({ now, heartbeat: true });

    // 24 mesi prima del 2026-07-20 -> 2024-07-20.
    const where = h.auditDeleteMany.mock.calls[0][0].where;
    expect(where.createdAt.lt).toEqual(new Date("2024-07-20T12:00:00.000Z"));
  });

  it("non pota senza il flag heartbeat", async () => {
    h.auditFindFirst.mockResolvedValue(null);

    const result = await processSignatureDeadlines({ now });

    expect(h.auditDeleteMany).not.toHaveBeenCalled();
    expect(result.auditPruned).toBe(0);
  });

  it("non pota due volte al giorno: col battito di oggi gia' scritto salta", async () => {
    h.auditFindFirst.mockResolvedValue({ id: "audit_existing" });

    const result = await processSignatureDeadlines({ now, heartbeat: true });

    expect(h.auditDeleteMany).not.toHaveBeenCalled();
    expect(result.auditPruned).toBe(0);
  });
});
