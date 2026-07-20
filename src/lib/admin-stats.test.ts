import { describe, expect, it } from "vitest";
import { summarizeCancellations } from "@/lib/admin-stats";

// summarizeCancellations e' la sorgente unica (prod + demo). Il breakdown delle causali deve
// riportare solo i preset noti: qualsiasi testo libero confluisce in "Altro" senza mai stampare
// cio' che l'utente ha digitato, cosi' un eventuale nome nel campo libero non finisce nelle
// statistiche (invariante: le statistiche non espongono nomi).
describe("summarizeCancellations", () => {
  it("separa gli automatici dai manuali e ne calcola le percentuali", () => {
    const stats = summarizeCancellations([
      { autoCanceledAt: new Date("2026-07-01T10:00:00.000Z"), cancelReason: null },
      { autoCanceledAt: new Date("2026-07-02T10:00:00.000Z"), cancelReason: null },
      { autoCanceledAt: null, cancelReason: "Maltempo" },
      { autoCanceledAt: null, cancelReason: null },
    ]);

    expect(stats.total).toBe(4);
    expect(stats.auto).toBe(2);
    expect(stats.manual).toBe(2);
    expect(stats.autoPercent).toBe(50);
    expect(stats.manualPercent).toBe(50);
    expect(stats.manualWithoutReason).toBe(1);
  });

  it("tiene distinti i preset noti e li ordina per frequenza", () => {
    const stats = summarizeCancellations([
      { autoCanceledAt: null, cancelReason: "Imprevisto" },
      { autoCanceledAt: null, cancelReason: "Maltempo" },
      { autoCanceledAt: null, cancelReason: "Maltempo" },
    ]);

    expect(stats.reasons).toEqual([
      { reason: "Maltempo", count: 2 },
      { reason: "Imprevisto", count: 1 },
    ]);
  });

  it("collassa il testo libero in 'Altro' senza esporre cio' che l'utente ha scritto", () => {
    const stats = summarizeCancellations([
      { autoCanceledAt: null, cancelReason: "Mario Rossi non viene" },
      { autoCanceledAt: null, cancelReason: "chiamare Laura Bianchi" },
      { autoCanceledAt: null, cancelReason: "Maltempo" },
    ]);

    // Nessuna delle stringhe libere compare verbatim.
    const reasonLabels = stats.reasons.map((entry) => entry.reason);
    expect(reasonLabels).not.toContain("Mario Rossi non viene");
    expect(reasonLabels).not.toContain("chiamare Laura Bianchi");
    // Il testo libero e' tutto sotto un unico "Altro".
    expect(stats.reasons).toEqual([
      { reason: "Altro", count: 2 },
      { reason: "Maltempo", count: 1 },
    ]);
  });
});
