import { describe, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { processSignatureDeadlines, resetOpportunisticSignatureThrottle } from "@/lib/signature-workflow";
import { normalizeEmail } from "@/lib/manage-token";
import {
  insertSignature,
  integrationDbReady,
  resetDatabase,
  settle,
  skipIntegrationReason,
} from "@/lib/int-test-support";
import { registerDeadlineProcessParity } from "@/lib/parity/scenarios";
import type {
  ParityDeadlineDriver,
  ParityDeadlineSeedInput,
  ParityDeadlineSeedResult,
  ParityDeadlineSnapshot,
} from "@/lib/parity/scenarios";

// Lato INTEGRAZIONE dell'harness di parita' per il PROCESSO SCADENZE FIRME: gli stessi scenari di
// scenarios.ts girano contro un Postgres vero via processSignatureDeadlines (il cron diretto, che per
// invariante NON passa dal throttle opportunistico). Se il ramo Prisma devia dalle attese condivise
// rompe qui; se devia il demo rompe il lato unit. In nessun caso la divergenza resta invisibile.

const hour = 60 * 60_000;

// seedPendingBooking e' il gemello Prisma di demoSeedPendingBooking: costruisce la stessa pending (o
// CONFIRMED) con scadenza, finestra, stato sollecito e firme preesistenti scelti a mano, via
// prisma.booking.create + insertSignature. Non e' il flusso sotto esame: e' il terreno comune, serve
// dove la create pubblica non sa costruire lo stato (deadline gia' passata, sollecito gia' inviato).
async function seedPendingBooking(input: ParityDeadlineSeedInput): Promise<ParityDeadlineSeedResult> {
  const end = input.end ?? new Date(input.start.getTime() + hour);
  const status = input.status ?? "PENDING_SIGNATURES";
  const playerCount = input.playerCount ?? 2;

  const booking = await prisma.booking.create({
    data: {
      start: input.start,
      end,
      status,
      organizerName: "Mario Rossi",
      organizerEmail: normalizeEmail(`org-${Math.random().toString(36).slice(2)}@example.com`),
      playerCount,
      signatureDeadlineAt: input.signatureDeadlineAt,
      signatureWindowStartedAt: input.signatureWindowStartedAt ?? null,
      signatureReminderSentAt: input.signatureReminderSentAt ?? null,
      signatureConfirmedAt: status === "CONFIRMED" ? new Date() : null,
      outlookSyncStatus: "SKIPPED",
    },
  });

  const signedCount = input.signedCount ?? 0;
  for (let index = 0; index < signedCount; index += 1) {
    await insertSignature({
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: index === 0 ? "ORGANIZER" : "GUEST",
      signerName: `Firmatario ${index + 1}`,
      signerEmail: normalizeEmail(`signer-${index}-${Math.random().toString(36).slice(2)}@example.com`),
      bookingEnd: end,
    });
  }

  return { bookingId: booking.id };
}

async function readDeadlineSnapshot(bookingId: string): Promise<ParityDeadlineSnapshot | null> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return null;
  return {
    status: booking.status,
    reminderSent: booking.signatureReminderSentAt !== null,
    autoCanceled: booking.autoCanceledAt !== null,
  };
}

if (!integrationDbReady) {
  describe.skip("parita processo scadenze - prisma (Postgres)", () => {
    it.skip(skipIntegrationReason, () => {});
  });
} else {
  const driver: ParityDeadlineDriver = {
    label: "prisma (Postgres)",
    reset: async () => {
      // Il cron diretto non passa dal throttle, ma azzeriamo comunque lo stato module-level per non
      // dipendere dall'ordine dei file.
      resetOpportunisticSignatureThrottle();
      await resetDatabase();
    },
    settle: () => settle(),
    teardown: async () => {
      await settle();
      await resetDatabase();
      await prisma.$disconnect();
    },
    seedPendingBooking,
    processDeadlines: (now) => processSignatureDeadlines({ now }),
    readDeadlineSnapshot,
  };

  registerDeadlineProcessParity(driver);
}
