import { beforeEach, describe, expect, it, vi } from "vitest";

// Il battito del cron firme deve lasciare una traccia anche in una giornata senza pending, cosi'
// un cron fermo si nota. Qui verifichiamo il wiring col database mockato: heartbeat scritto al
// primo giro del giorno, non duplicato ai giri successivi, assente quando il flag non arriva
// (cioe' dalla pulizia opportunistica, che non deve mascherare un cron fermo).
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

describe("heartbeat cron firme", () => {
  beforeEach(() => {
    h.auditCreate.mockReset();
    h.auditFindFirst.mockReset();
    h.auditDeleteMany.mockReset();
    h.auditDeleteMany.mockResolvedValue({ count: 0 });
    h.findMany.mockReset();

    // Nessuna pending: la giornata e' tranquilla, il battito e' l'unica traccia possibile.
    h.findMany.mockResolvedValue([]);
  });

  it("scrive il battito al primo giro del giorno quando il flag arriva", async () => {
    h.auditFindFirst.mockResolvedValue(null);

    await processSignatureDeadlines({ now, heartbeat: true });

    const heartbeat = h.auditCreate.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.action === "SIGNATURE_DEADLINES_HEARTBEAT");
    expect(heartbeat).toBeDefined();
    expect(heartbeat.actorEmail).toBe("system");
    expect(heartbeat.entityType).toBe("System");
  });

  it("non duplica il battito quando la riga di oggi esiste gia'", async () => {
    h.auditFindFirst.mockResolvedValue({ id: "audit_existing" });

    await processSignatureDeadlines({ now, heartbeat: true });

    const actions = h.auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).not.toContain("SIGNATURE_DEADLINES_HEARTBEAT");
  });

  it("non scrive il battito senza il flag heartbeat", async () => {
    h.auditFindFirst.mockResolvedValue(null);

    await processSignatureDeadlines({ now });

    expect(h.auditFindFirst).not.toHaveBeenCalled();
    const actions = h.auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).not.toContain("SIGNATURE_DEADLINES_HEARTBEAT");
  });
});
