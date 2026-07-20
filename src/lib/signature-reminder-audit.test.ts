import { beforeEach, describe, expect, it, vi } from "vitest";

// processSignatureDeadlines gira solo col database configurato (in demo mode esce subito), quindi
// il ramo reminder si esercita mockando prisma, la mail e la coda after-response. Qui verifichiamo
// l'audit SINCERO: l'esito reale dell'invio finisce nel log, e il claim di concorrenza sul
// signatureReminderSentAt NON viene resettato quando la mail fallisce.
const h = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  sendReminder: vi.fn(),
  afterTasks: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: h.findMany,
      updateMany: h.updateMany,
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    auditLog: { create: h.auditCreate },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/graph", () => ({
  sendOrganizerSignatureReminderEmail: h.sendReminder,
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

function candidate() {
  return {
    id: "booking_1",
    playerCount: 4,
    waiverRevision: 1,
    waiverSignatures: [],
    createdAt: new Date(now.getTime() - 3 * 3_600_000),
    signatureWindowStartedAt: new Date(now.getTime() - 3 * 3_600_000),
    signatureDeadlineAt: new Date(now.getTime() + 3_600_000),
    signatureReminderSentAt: null,
  };
}

async function flushAfterTasks() {
  const tasks = h.afterTasks.splice(0);
  for (const task of tasks) {
    await task();
  }
}

describe("audit sollecito firme", () => {
  beforeEach(() => {
    h.afterTasks.length = 0;
    h.auditCreate.mockReset();
    h.updateMany.mockReset();
    h.findMany.mockReset();
    h.sendReminder.mockReset();

    h.updateMany.mockResolvedValue({ count: 1 });
    h.findMany.mockImplementation((args: { where: Record<string, unknown> }) =>
      Promise.resolve("signatureReminderSentAt" in args.where ? [candidate()] : []),
    );
  });

  it("registra REMINDER_SENT solo quando la mail parte davvero", async () => {
    h.sendReminder.mockResolvedValue({ status: "SENT" });

    await processSignatureDeadlines({ now });
    await flushAfterTasks();

    expect(h.sendReminder).toHaveBeenCalledTimes(1);
    const actions = h.auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).toContain("BOOKING_SIGNATURE_REMINDER_SENT");
    expect(actions).toContain("SIGNATURE_DEADLINES_RUN");
  });

  it("registra REMINDER_FAILED con l'errore quando la mail fallisce, senza resettare il claim", async () => {
    h.sendReminder.mockResolvedValue({ status: "FAILED", error: "graph ko" });

    const result = await processSignatureDeadlines({ now });
    await flushAfterTasks();

    // Il claim resta scritto: nessuna updateMany di reset, cosi' il cron non ritenta ogni 10 minuti.
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(result.reminded).toBe(1);

    const audit = h.auditCreate.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.action === "BOOKING_SIGNATURE_REMINDER_FAILED");
    expect(audit.after.emailStatus).toBe("FAILED");
    expect(audit.after.error).toBe("graph ko");
  });

  it("scrive una riga di sintesi della run quando c'e' attivita'", async () => {
    h.sendReminder.mockResolvedValue({ status: "SENT" });

    const result = await processSignatureDeadlines({ now });
    await flushAfterTasks();

    const summary = h.auditCreate.mock.calls
      .map((call) => call[0].data)
      .find((data) => data.action === "SIGNATURE_DEADLINES_RUN");
    expect(summary).toBeDefined();
    expect(summary.actorEmail).toBe("system");
    expect(summary.after).toEqual({ reminded: result.reminded, canceled: result.canceled });
  });

  it("ancora ENTRAMBI gli strati di dedup: filtro di query E claim atomico su signatureReminderSentAt: null", async () => {
    // I due strati si coprono a vicenda, quindi un test end-to-end sul "niente doppio sollecito" resta
    // verde anche togliendo un solo filtro. Qui li pinziamo singolarmente sulla forma degli argomenti:
    // rimuovere il filtro dalla query (findMany) O dalla updateMany-claim fa fallire una di queste due
    // asserzioni, non serve che cadano insieme.
    h.sendReminder.mockResolvedValue({ status: "SENT" });

    await processSignatureDeadlines({ now });
    await flushAfterTasks();

    const reminderQuery = h.findMany.mock.calls
      .map((call) => call[0])
      .find((args) => args?.where && "signatureReminderSentAt" in args.where);
    expect(reminderQuery?.where.signatureReminderSentAt).toBeNull();

    const claim = h.updateMany.mock.calls
      .map((call) => call[0])
      .find((args) => args?.data?.signatureReminderSentAt);
    expect(claim?.where?.signatureReminderSentAt).toBeNull();
  });

  it("non sollecita quando il claim atomico e' perso: updateMany count 0 -> niente mail ne' SENT", async () => {
    // Ragione d'essere della updateMany-claim: se una run concorrente ha gia' rivendicato la riga
    // (count 0), questa run non deve mandare il promemoria ne' registrare un invio.
    h.sendReminder.mockResolvedValue({ status: "SENT" });
    h.updateMany.mockResolvedValue({ count: 0 });

    const result = await processSignatureDeadlines({ now });
    await flushAfterTasks();

    expect(result.reminded).toBe(0);
    expect(h.sendReminder).not.toHaveBeenCalled();
    const actions = h.auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).not.toContain("BOOKING_SIGNATURE_REMINDER_SENT");
  });

  it("non scrive la riga di sintesi quando la run non fa nulla", async () => {
    // Nessun candidato: ne' reminder ne' cancellazioni, quindi niente riga a vuoto.
    h.findMany.mockResolvedValue([]);

    await processSignatureDeadlines({ now });
    await flushAfterTasks();

    const actions = h.auditCreate.mock.calls.map((call) => call[0].data.action);
    expect(actions).not.toContain("SIGNATURE_DEADLINES_RUN");
  });
});
