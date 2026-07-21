import { describe, it } from "vitest";
import {
  cancelBooking,
  createAdminBlock,
  createBooking,
  deleteAdminBlock,
  getAdminStats,
  getAvailability,
  listBookings,
  updateBooking,
} from "@/lib/booking-service";
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
  parityAdminUser,
  registerAdminBlockParity,
  registerAdminStatsParity,
  registerCancelBookingParity,
  registerListBookingsParity,
  registerUpdateBookingParity,
} from "@/lib/parity/scenarios";
import type {
  ParityBookingSnapshot,
  ParityManageSeedInput,
  ParityManageSeedResult,
  ParityManagementDriver,
} from "@/lib/parity/scenarios";

// Lato INTEGRAZIONE dell'harness di parita' per i flussi di GESTIONE: gli stessi scenari di
// scenarios.ts girano contro un Postgres vero attraverso le funzioni di produzione (con
// DATABASE_URL, update/cancel/list/blocchi instradano su Prisma, non sul demo). Se il ramo Prisma
// devia dalle attese condivise rompe qui; se devia il demo rompe il lato unit. In nessun caso la
// divergenza resta invisibile.

// L'admin va seminato come riga User vera: createAdminBlock scrive AdminBlock.createdById e l'audit
// scrive AuditLog.actorId, entrambe foreign key verso User. Usiamo lo STESSO id dell'oggetto
// condiviso (parityAdminUser.id) cosi' il lato int e il lato demo parlano dello stesso admin.
async function seedParityAdmin() {
  await prisma.user.create({
    data: {
      id: parityAdminUser.id,
      email: parityAdminUser.email,
      name: parityAdminUser.name,
      role: "ADMIN",
    },
  });
}

// seedManagedBooking e' il gemello Prisma di demoSeedManagedBooking: costruisce lo stesso stato di
// partenza (una prenotazione con la firma dell'organizzatore e un manage token in chiaro, che il
// flusso reale salva solo come hash) via prisma.booking.create + insertSignature. Non e' il flusso
// sotto esame: e' il terreno comune, serve dove la create pubblica non sa costruire lo stato (una
// partita gia' iniziata: rifiuta il passato e non restituisce il token).
async function seedManagedBooking(input: ParityManageSeedInput): Promise<ParityManageSeedResult> {
  const status = input.status ?? "CONFIRMED";
  const playerCount = input.playerCount ?? 2;
  const organizerName = normalizePersonName(input.organizerName ?? "Luca Bianchi");
  const organizerEmail = normalizeEmail(input.organizerEmail ?? "luca.bianchi@example.com");
  const manageToken = createManageToken();
  const guestWaiverToken = createManageToken();

  const booking = await prisma.booking.create({
    data: {
      start: input.start,
      end: input.end,
      status,
      organizerName,
      organizerEmail,
      playerCount,
      manageTokenHash: hashManageToken(manageToken),
      manageTokenExpiresAt: manageTokenExpiresAt(input.end),
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

  if (input.withGuestSignature) {
    await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "GUEST",
      signerName: normalizePersonName("Marco Verdi"),
      signerEmail: normalizeEmail("marco.verdi@example.com"),
      bookingEnd: input.end,
    });
  }

  return { bookingId: booking.id, manageToken, guestWaiverToken };
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
  describe.skip("parita gestione - prisma (Postgres)", () => {
    it.skip(skipIntegrationReason, () => {});
  });
} else {
  const driver: ParityManagementDriver = {
    label: "prisma (Postgres)",
    reset: async () => {
      // Il throttle della pulizia opportunistica e' module-level e sopravvive tra i file: azzerarlo a
      // ogni scenario garantisce che la prima chiamata di servizio esegua davvero la pulizia, cosi'
      // l'esito e' deterministico come in demo.
      resetOpportunisticSignatureThrottle();
      await resetDatabase();
      await seedParityAdmin();
    },
    settle: () => settle(),
    teardown: async () => {
      await settle();
      await resetDatabase();
      await prisma.$disconnect();
    },
    adminUser: parityAdminUser,
    createBooking,
    updateBooking,
    cancelBooking,
    listBookings,
    getAdminStats,
    getAvailability,
    createAdminBlock,
    deleteAdminBlock,
    seedManagedBooking,
    readBookingSnapshot,
  };

  registerUpdateBookingParity(driver);
  registerCancelBookingParity(driver);
  registerListBookingsParity(driver);
  registerAdminStatsParity(driver);
  registerAdminBlockParity(driver);
}
