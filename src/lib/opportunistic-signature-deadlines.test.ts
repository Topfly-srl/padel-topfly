import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// La pulizia opportunistica gira in testa alle richieste utente: un errore della manutenzione non
// deve far fallire la richiesta che la ospita. Il cron (route interna) chiama invece
// processSignatureDeadlines diretta e DEVE continuare a vedere gli errori. Qui esercitiamo
// entrambi i rami mockando prisma perche' processSignatureDeadlines gira solo col db configurato.
const h = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { databaseConfigured: true },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: h.findMany,
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn() },
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
  runAfterResponse: vi.fn(),
}));

const {
  processSignatureDeadlines,
  runOpportunisticSignatureDeadlines,
  resetOpportunisticSignatureThrottle,
} = await import("@/lib/signature-workflow");

describe("runOpportunisticSignatureDeadlines", () => {
  beforeEach(() => {
    h.findMany.mockReset();
    // Il throttle e' module-level: senza reset il secondo test dello stesso file, che gira nello
    // stesso secondo, verrebbe frenato prima di toccare il mock.
    resetOpportunisticSignatureThrottle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("non propaga alla richiesta ospite gli errori della manutenzione, ma li logga", async () => {
    h.findMany.mockRejectedValue(new Error("db giu'"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Il cron vede l'errore: la route interna deve poter fallire e segnalarlo.
    await expect(processSignatureDeadlines()).rejects.toThrow("db giu'");

    // La richiesta utente no: la pulizia lo inghiotte e restituisce l'esito neutro.
    await expect(runOpportunisticSignatureDeadlines()).resolves.toEqual({
      reminded: 0,
      canceled: 0,
    });
    expect(spy).toHaveBeenCalled();
  });

  it("in condizioni normali restituisce il conteggio della manutenzione", async () => {
    h.findMany.mockResolvedValue([]);

    await expect(runOpportunisticSignatureDeadlines()).resolves.toEqual({
      reminded: 0,
      canceled: 0,
      auditPruned: 0,
    });
  });

  it("frena i giri ravvicinati: il secondo salta senza toccare il DB", async () => {
    h.findMany.mockResolvedValue([]);

    await runOpportunisticSignatureDeadlines();
    expect(h.findMany).toHaveBeenCalled();

    h.findMany.mockClear();

    // Secondo giro nello stesso secondo: throttle, nessuna query, esito neutro a due campi.
    await expect(runOpportunisticSignatureDeadlines()).resolves.toEqual({
      reminded: 0,
      canceled: 0,
    });
    expect(h.findMany).not.toHaveBeenCalled();
  });
});
