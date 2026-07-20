import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { cancelGuestWaiverSignature } from "@/lib/waiver-service";
import { createManageToken } from "@/lib/manage-token";
import {
  insertSignature,
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";

const hour = 60 * 60_000;
const minute = 60_000;

// Flusso critico n.3 su DB vero: un ospite rinuncia al posto di una prenotazione CONFIRMED. La
// firma va annullata, la prenotazione deve tornare PENDING_SIGNATURES e ricevere una finestra di
// sostituzione (non i 30 minuti del last minute), cosi' chi resta ha tempo di trovare un altro.
describe.skipIf(!integrationDbReady)("cancelGuestWaiverSignature: revert CONFIRMED -> PENDING (DB vero)", () => {
  if (!integrationDbReady) {
    it.skip(skipIntegrationReason, () => {});
    return;
  }

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await settle();
    await resetDatabase();
    await prisma.$disconnect();
  });

  it("riporta la prenotazione in attesa firme con la finestra di sostituzione", async () => {
    const now = Date.now();
    const start = new Date(now + 3 * hour);
    const end = new Date(now + 4 * hour);

    const booking = await prisma.booking.create({
      data: {
        start,
        end,
        status: "CONFIRMED",
        organizerName: "Luca Bianchi",
        organizerEmail: "luca.bianchi@example.com",
        playerCount: 2,
        signatureConfirmedAt: new Date(),
        signatureDeadlineAt: null,
        outlookSyncStatus: "SKIPPED",
      },
    });

    await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "ORGANIZER",
      signerName: "Luca Bianchi",
      signerEmail: "luca.bianchi@example.com",
      bookingEnd: end,
    });

    const cancelToken = createManageToken();
    const guestSignature = await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "GUEST",
      signerName: "Marco Verdi",
      signerEmail: "marco.verdi@example.com",
      bookingEnd: end,
      cancelToken,
    });

    const before = Date.now();
    const context = await cancelGuestWaiverSignature(guestSignature.id, cancelToken);

    expect(context.signature.status).toBe("CANCELED");
    expect(context.canCancel).toBe(false);
    expect(context.booking.status).toBe("PENDING_SIGNATURES");

    const revertedBooking = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { waiverSignatures: true },
    });

    expect(revertedBooking.status).toBe("PENDING_SIGNATURES");
    expect(revertedBooking.signatureConfirmedAt).toBeNull();
    expect(revertedBooking.signatureReminderSentAt).toBeNull();
    expect(revertedBooking.autoCanceledAt).toBeNull();
    expect(revertedBooking.signatureWindowStartedAt).not.toBeNull();

    // Finestra di sostituzione: circa 2 ore prima dell'inizio (start e' now + 3h), mai i 30 minuti
    // del ramo last minute e mai oltre l'inizio.
    const deadline = revertedBooking.signatureDeadlineAt;
    expect(deadline).not.toBeNull();
    const deadlineMs = deadline!.getTime();
    expect(deadlineMs).toBeGreaterThan(before);
    expect(deadlineMs).toBeLessThanOrEqual(start.getTime());
    expect(deadlineMs - before).toBeGreaterThan(2 * hour - 5 * minute);
    expect(deadlineMs - before).toBeLessThan(2 * hour + 5 * minute);

    const activeSignatures = revertedBooking.waiverSignatures.filter(
      (signature) => signature.status === "ACTIVE" && signature.bookingRevision === revertedBooking.waiverRevision,
    );
    expect(activeSignatures).toHaveLength(1);
    expect(activeSignatures[0].signerRole).toBe("ORGANIZER");

    const canceledGuest = await prisma.waiverSignature.findUniqueOrThrow({
      where: { id: guestSignature.id },
    });
    expect(canceledGuest.status).toBe("CANCELED");
    expect(canceledGuest.canceledAt).not.toBeNull();

    // Traccia di audit del revert.
    const incompleteAudit = await prisma.auditLog.findFirst({
      where: { action: "BOOKING_SIGNATURES_INCOMPLETE", entityId: booking.id },
    });
    expect(incompleteAudit).not.toBeNull();

    await settle();
  });

  it("e' idempotente: una seconda rinuncia con lo stesso link non cambia nulla", async () => {
    const now = Date.now();
    const start = new Date(now + 3 * hour);
    const end = new Date(now + 4 * hour);

    const booking = await prisma.booking.create({
      data: {
        start,
        end,
        status: "CONFIRMED",
        organizerName: "Sara Neri",
        organizerEmail: "sara.neri@example.com",
        playerCount: 2,
        signatureConfirmedAt: new Date(),
        outlookSyncStatus: "SKIPPED",
      },
    });

    await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "ORGANIZER",
      signerName: "Sara Neri",
      signerEmail: "sara.neri@example.com",
      bookingEnd: end,
    });

    const cancelToken = createManageToken();
    const guestSignature = await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "GUEST",
      signerName: "Gino Blu",
      signerEmail: "gino.blu@example.com",
      bookingEnd: end,
      cancelToken,
    });

    await cancelGuestWaiverSignature(guestSignature.id, cancelToken);
    const deadlineAfterFirst = (
      await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })
    ).signatureDeadlineAt;

    const secondContext = await cancelGuestWaiverSignature(guestSignature.id, cancelToken);
    expect(secondContext.signature.status).toBe("CANCELED");

    const bookingAfterSecond = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(bookingAfterSecond.status).toBe("PENDING_SIGNATURES");
    // La seconda rinuncia non riapre la finestra ne' tocca la deadline.
    expect(bookingAfterSecond.signatureDeadlineAt?.getTime()).toBe(deadlineAfterFirst?.getTime());

    await settle();
  });
});
