import { describe, it } from "vitest";
import { createBooking } from "@/lib/booking-service";
import {
  cancelGuestWaiverSignature,
  getGuestWaiverCancelContext,
  getWaiverContext,
  signGuestWaiver,
} from "@/lib/waiver-service";
import { prisma } from "@/lib/prisma";
import { resetOpportunisticSignatureThrottle } from "@/lib/signature-workflow";
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
import {
  registerGuestCancelParity,
  registerGuestSignatureParity,
  registerWaiverContextParity,
} from "@/lib/parity/scenarios";
import type {
  ParityBookingSnapshot,
  ParitySeedInput,
  ParitySeedResult,
  ParitySignatureDriver,
} from "@/lib/parity/scenarios";

// Lato INTEGRAZIONE dell'harness di parita' per i flussi FIRMA: gli stessi scenari di scenarios.ts
// girano contro un Postgres vero attraverso le funzioni di produzione (con DATABASE_URL,
// signGuestWaiver/cancelGuestWaiverSignature instradano su Prisma, non sul demo). Se il ramo Prisma
// devia dalle attese condivise rompe qui; se devia il demo rompe il lato unit. In nessun caso la
// divergenza resta invisibile.

// seedGuestBooking e' il gemello Prisma di demoSeedGuestBooking: costruisce lo stesso stato di
// partenza (una pending con la finestra gia' chiusa, o una CONFIRMED con un posto ospite da
// rinunciare) via prisma.booking.create + insertSignature, con i token in chiaro che il flusso
// reale salva solo come hash. Non e' il flusso sotto esame: e' il terreno comune.
async function seedGuestBooking(input: ParitySeedInput): Promise<ParitySeedResult> {
  const status = input.status ?? "CONFIRMED";
  const playerCount = input.playerCount ?? 2;
  const organizerName = normalizePersonName(input.organizerName ?? "Luca Bianchi");
  const organizerEmail = normalizeEmail(input.organizerEmail ?? "luca.bianchi@example.com");
  const guestWaiverToken = createManageToken();

  const booking = await prisma.booking.create({
    data: {
      start: input.start,
      end: input.end,
      status,
      organizerName,
      organizerEmail,
      playerCount,
      signatureDeadlineAt: input.signatureDeadlineAt ?? null,
      signatureWindowStartedAt: new Date(),
      signatureConfirmedAt: status === "CONFIRMED" ? new Date() : null,
      outlookSyncStatus: "SKIPPED",
      guestWaiverTokenHash: hashManageToken(guestWaiverToken),
      guestWaiverTokenExpiresAt: manageTokenExpiresAt(input.end),
    },
  });

  await insertSignature({
    bookingId: booking.id,
    bookingRevision: booking.waiverRevision,
    signerRole: "ORGANIZER",
    signerName: organizerName,
    signerEmail: organizerEmail,
    bookingEnd: input.end,
  });

  let signatureId: string | undefined;
  let cancelToken: string | undefined;
  if (input.withGuestSignature) {
    cancelToken = createManageToken();
    const guest = await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "GUEST",
      signerName: normalizePersonName(input.guestName ?? "Marco Verdi"),
      signerEmail: normalizeEmail(input.guestEmail ?? "marco.verdi@example.com"),
      bookingEnd: input.end,
      cancelToken,
    });
    signatureId = guest.id;
  }

  return { bookingId: booking.id, guestWaiverToken, signatureId, cancelToken };
}

async function readBookingSnapshot(bookingId: string): Promise<ParityBookingSnapshot | null> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return null;
  return {
    status: booking.status,
    signatureDeadlineMs: booking.signatureDeadlineAt?.getTime() ?? null,
  };
}

if (!integrationDbReady) {
  describe.skip("parita flussi firma - prisma (Postgres)", () => {
    it.skip(skipIntegrationReason, () => {});
  });
} else {
  const driver: ParitySignatureDriver = {
    label: "prisma (Postgres)",
    reset: async () => {
      // Il throttle della pulizia opportunistica e' module-level e sopravvive tra i file: azzerarlo
      // a ogni scenario garantisce che la prima chiamata di servizio (es. signGuestWaiver sulla
      // finestra chiusa) esegua davvero la pulizia, cosi' l'esito e' deterministico come in demo.
      resetOpportunisticSignatureThrottle();
      await resetDatabase();
    },
    settle: () => settle(),
    teardown: async () => {
      await settle();
      await resetDatabase();
      await prisma.$disconnect();
    },
    createBooking,
    getWaiverContext,
    signGuestWaiver,
    seedGuestBooking,
    getGuestWaiverCancelContext,
    cancelGuestWaiverSignature,
    readBookingSnapshot,
  };

  registerGuestSignatureParity(driver);
  registerWaiverContextParity(driver);
  registerGuestCancelParity(driver);
}
