import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManageToken,
  hashManageToken,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import {
  insertSignature,
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";
import { futureSlot } from "@/lib/parity/fixtures";

// Le gare tra richieste concorrenti (annulla vs modifica, annulla vs annulla) e i task Outlook
// tardivi si possono esercitare solo contro un Postgres vero: il demo e' single-thread e non ha
// transazioni. Graph e' mockato per osservare creazioni e compensazioni senza rete.
vi.mock("@/lib/graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/graph")>();
  return {
    ...actual,
    createOutlookEvent: vi.fn(async () => ({ status: "SYNCED" as const, eventId: "evt-tardivo" })),
    updateOutlookEvent: vi.fn(async () => ({ status: "SYNCED" as const, eventId: "evt-tardivo" })),
    deleteOutlookEvent: vi.fn(async () => ({ status: "SYNCED" as const })),
    // Le ricevute di annullo sono mockate per poterle CONTARE: il perdente della gara non deve
    // rispedirle (senza mock partirebbero in modalita' SKIPPED silenziosa, invisibili al test).
    sendOrganizerBookingCanceledEmail: vi.fn(async () => undefined),
    sendGuestBookingCanceledEmail: vi.fn(async () => undefined),
  };
});

const { cancelBooking, updateBooking } = await import("@/lib/booking-service");
const { syncConfirmedBooking } = await import("@/lib/signature-workflow");
const { prisma } = await import("@/lib/prisma");
const graph = await import("@/lib/graph");

// Stato di partenza CONFIRMED con firma organizzatore e manage token in chiaro: stesso seed dei
// test di parita' gestione (la create pubblica non restituisce il token in chiaro).
async function seedConfirmedBooking(index: number) {
  const slot = futureSlot(1 + index);
  const organizerName = normalizePersonName(`Gara Concorrente ${index}`);
  const organizerEmail = normalizeEmail(`gara.concorrente${index}@example.com`);
  const manageToken = createManageToken();

  const booking = await prisma.booking.create({
    data: {
      start: slot.start,
      end: slot.end,
      status: "CONFIRMED",
      organizerName,
      organizerEmail,
      playerCount: 2,
      manageTokenHash: hashManageToken(manageToken),
      manageTokenExpiresAt: manageTokenExpiresAt(slot.end),
      signatureWindowStartedAt: new Date(),
      signatureConfirmedAt: new Date(),
      outlookSyncStatus: "SKIPPED",
    },
  });

  await insertSignature({
    bookingId: booking.id,
    bookingRevision: booking.waiverRevision,
    signerRole: "ORGANIZER",
    signerName: organizerName,
    signerEmail: organizerEmail,
    bookingEnd: slot.end,
  });

  return { booking, manageToken, slot };
}

if (!integrationDbReady) {
  describe.skip("concorrenza prenotazioni (DB vero)", () => {
    it.skip(skipIntegrationReason, () => {});
  });
} else {
  describe("concorrenza prenotazioni (DB vero)", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      await resetDatabase();
    });

    it("annulla e modifica in gara: la prenotazione resta annullata, un solo audit di annullo", async () => {
      // La gara e' intrinsecamente non deterministica nell'ORDINE, ma l'esito deve rispettare
      // sempre lo stesso invariante: l'annullo (non-admin non puo' riattivare) vince SEMPRE lo
      // stato finale, e l'audit BOOKING_CANCELED e' scritto una volta sola. Otto giri alzano la
      // probabilita' di esercitare entrambi gli ordini di commit.
      for (let round = 0; round < 8; round += 1) {
        const { booking, manageToken, slot } = await seedConfirmedBooking(round);
        const shiftedStart = new Date(slot.start.getTime() + 15 * 60_000);
        const shiftedEnd = new Date(slot.end.getTime() + 15 * 60_000);

        const [updateResult] = await Promise.allSettled([
          updateBooking({ manageToken }, booking.id, { start: shiftedStart, end: shiftedEnd }),
          cancelBooking({ manageToken }, booking.id),
        ]);
        await settle();

        const finalRow = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(finalRow.status, `giro ${round}: lo stato finale deve restare annullato`).toBe("CANCELED");

        const cancelAudits = await prisma.auditLog.count({
          where: { action: "BOOKING_CANCELED", entityId: booking.id },
        });
        expect(cancelAudits, `giro ${round}: un solo audit di annullo`).toBe(1);

        // La modifica o e' passata PRIMA dell'annullo (e l'annullo l'ha poi sovrascritta) o e'
        // stata rifiutata con il 409 della guardia: mai un successo che resuscita la partita.
        if (updateResult.status === "rejected") {
          expect(String((updateResult.reason as Error).message)).toMatch(
            /modificata nel frattempo|annullata/i,
          );
        }
      }
    });

    it("doppio annullo concorrente: entrambi rispondono ok, audit e mail una volta sola", async () => {
      const { booking, manageToken } = await seedConfirmedBooking(100);

      const results = await Promise.allSettled([
        cancelBooking({ manageToken }, booking.id),
        cancelBooking({ manageToken }, booking.id),
      ]);
      await settle();

      // Idempotenza: il perdente della gara non deve fallire, deve rispondere come il percorso
      // "gia' annullata".
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      const cancelAudits = await prisma.auditLog.count({
        where: { action: "BOOKING_CANCELED", entityId: booking.id },
      });
      expect(cancelAudits).toBe(1);
      // ...e la ricevuta di annullo al referente parte UNA volta sola: il perdente della gara
      // rientra nel percorso idempotente senza rispedire nulla.
      expect(graph.sendOrganizerBookingCanceledEmail).toHaveBeenCalledTimes(1);
    });

    it("sync Outlook tardiva su prenotazione annullata: niente event id scritto e evento compensato", async () => {
      const { booking } = await seedConfirmedBooking(200);

      // Il task tardivo lavora su uno snapshot ancora CONFIRMED, ma nel frattempo la
      // prenotazione e' stata annullata: lo scenario B4 esatto, riprodotto in modo deterministico.
      const staleSnapshot = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELED" } });

      const returned = await syncConfirmedBooking({ booking: staleSnapshot });

      expect(returned.status).toBe("CANCELED");
      const finalRow = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(finalRow.outlookEventId).toBeNull();
      expect(finalRow.status).toBe("CANCELED");
      // L'evento creato per sbaglio non deve restare vivo nel calendario: compensazione col
      // commento coerente allo stato reale (qui annullata, non "in attesa firme").
      expect(graph.deleteOutlookEvent).toHaveBeenCalledWith(
        expect.objectContaining({ id: booking.id, outlookEventId: "evt-tardivo" }),
        "canceled",
      );
    });

    it("sync Outlook su prenotazione ancora confermata: event id scritto, nessuna compensazione", async () => {
      const { booking } = await seedConfirmedBooking(300);
      const snapshot = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });

      const returned = await syncConfirmedBooking({ booking: snapshot });

      expect(returned.outlookEventId).toBe("evt-tardivo");
      expect(returned.outlookSyncStatus).toBe("SYNCED");
      expect(graph.deleteOutlookEvent).not.toHaveBeenCalled();
    });
  });
}
