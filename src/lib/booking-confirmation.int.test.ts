import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createBooking } from "@/lib/booking-service";
import { signGuestWaiver } from "@/lib/waiver-service";
import {
  buildWaiverInput,
  futureSlot,
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";

// Flusso critico n.1 su DB vero: createBooking -> firma ospite -> booking CONFIRMED. In demo mode
// (unit) questo percorso non tocca mai Prisma: qui invece esercitiamo la transazione Serializable
// reale, la dedup delle firme e il passaggio a CONFIRMED all'ultima firma.
describe.skipIf(!integrationDbReady)("createBooking -> firma ospite -> CONFIRMED (DB vero)", () => {
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

  it("resta PENDING alla creazione e diventa CONFIRMED quando l'ospite firma", async () => {
    const { start, end } = futureSlot();

    const created = await createBooking({
      start,
      end,
      organizerName: "Luca Bianchi",
      organizerEmail: "luca.bianchi@example.com",
      playerCount: 2,
      waiver: buildWaiverInput({
        signerName: "Luca Bianchi",
        signerEmail: "luca.bianchi@example.com",
      }),
      waiverEvidence: {},
      baseUrl: "https://padel.test",
    });

    expect(created.status).toBe("PENDING_SIGNATURES");
    expect(created.guestWaiverToken).toBeTruthy();

    const afterCreate = await prisma.booking.findUniqueOrThrow({
      where: { id: created.id },
      include: { waiverSignatures: true },
    });
    expect(afterCreate.status).toBe("PENDING_SIGNATURES");
    expect(afterCreate.signatureConfirmedAt).toBeNull();
    const organizerSignatures = afterCreate.waiverSignatures.filter(
      (signature) => signature.status === "ACTIVE" && signature.bookingRevision === afterCreate.waiverRevision,
    );
    expect(organizerSignatures).toHaveLength(1);
    expect(organizerSignatures[0].signerRole).toBe("ORGANIZER");

    await signGuestWaiver(
      created.id,
      created.guestWaiverToken ?? null,
      buildWaiverInput({
        signerName: "Marco Verdi",
        signerEmail: "marco.verdi@example.com",
      }),
      {},
      "https://padel.test",
    );

    const confirmed = await prisma.booking.findUniqueOrThrow({
      where: { id: created.id },
      include: { waiverSignatures: true },
    });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.signatureConfirmedAt).not.toBeNull();

    const activeSignatures = confirmed.waiverSignatures.filter(
      (signature) => signature.status === "ACTIVE" && signature.bookingRevision === confirmed.waiverRevision,
    );
    expect(activeSignatures).toHaveLength(2);
    expect(new Set(activeSignatures.map((signature) => signature.signerRole))).toEqual(
      new Set(["ORGANIZER", "GUEST"]),
    );

    await settle();
  });

  it("rifiuta una seconda firma con la stessa email sulla stessa prenotazione", async () => {
    const { start, end } = futureSlot(2);

    const created = await createBooking({
      start,
      end,
      organizerName: "Sara Neri",
      organizerEmail: "sara.neri@example.com",
      playerCount: 3,
      waiver: buildWaiverInput({ signerName: "Sara Neri", signerEmail: "sara.neri@example.com" }),
      waiverEvidence: {},
      baseUrl: "https://padel.test",
    });

    await signGuestWaiver(
      created.id,
      created.guestWaiverToken ?? null,
      buildWaiverInput({ signerName: "Gino Blu", signerEmail: "gino.blu@example.com" }),
      {},
      "https://padel.test",
    );

    await expect(
      signGuestWaiver(
        created.id,
        created.guestWaiverToken ?? null,
        buildWaiverInput({ signerName: "Gino Blu", signerEmail: "gino.blu@example.com" }),
        {},
        "https://padel.test",
      ),
    ).rejects.toThrow();

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: created.id },
      include: { waiverSignatures: true },
    });
    expect(booking.status).toBe("PENDING_SIGNATURES");
    const active = booking.waiverSignatures.filter(
      (signature) => signature.status === "ACTIVE" && signature.bookingRevision === booking.waiverRevision,
    );
    expect(active).toHaveLength(2);

    await settle();
  });
});
