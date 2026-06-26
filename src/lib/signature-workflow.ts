import type { Booking, Prisma } from "@prisma/client";
import { runAfterResponse } from "@/lib/after-response";
import { appConfig } from "@/lib/config";
import {
  createOutlookEvent,
  deleteOutlookEvent,
  sendGuestBookingCanceledEmail,
  sendOrganizerAutoCanceledEmail,
  sendOrganizerPendingSignatureEmail,
  sendOrganizerSignatureReminderEmail,
} from "@/lib/graph";
import { prisma } from "@/lib/prisma";
import { retryPrismaTransaction } from "@/lib/prisma-retry";

const longDeadlineMs = 24 * 60 * 60_000;
const signatureCutoffBeforeStartMs = 4 * 60 * 60_000;
const lastMinuteDeadlineMs = 30 * 60_000;
const reminderLeadMs = 60 * 60_000;

type BookingWithSignatureDeadlineFields = Pick<
  Booking,
  "start" | "signatureDeadlineAt"
>;

type GuestSigner = {
  signerName: string;
  signerEmail: string;
};

export function signatureDeadlineAt(start: Date, createdAt = new Date()) {
  const cutoffBeforeStart = new Date(start.getTime() - signatureCutoffBeforeStartMs);

  if (cutoffBeforeStart <= createdAt) {
    return minDate(new Date(createdAt.getTime() + lastMinuteDeadlineMs), start);
  }

  return minDate(new Date(createdAt.getTime() + longDeadlineMs), cutoffBeforeStart);
}

export function isActiveBookingStatus(status: Booking["status"]) {
  return status === "CONFIRMED" || status === "PENDING_SIGNATURES";
}

export function isBookingVisibleAsBusy(booking: BookingWithSignatureDeadlineFields & Pick<Booking, "status">, now = new Date()) {
  return (
    booking.status === "CONFIRMED" ||
    (booking.status === "PENDING_SIGNATURES" &&
      (!booking.signatureDeadlineAt || booking.signatureDeadlineAt > now))
  );
}

function minDate(left: Date, right: Date) {
  return left <= right ? left : right;
}

function organizerContact(booking: Pick<Booking, "organizerName" | "organizerEmail">) {
  return {
    name: booking.organizerName,
    email: booking.organizerEmail,
  };
}

function signedCountWhere(booking: Pick<Booking, "id" | "waiverRevision">) {
  return {
    bookingId: booking.id,
    bookingRevision: booking.waiverRevision,
    status: "ACTIVE" as const,
  };
}

async function activeSignatureCount(tx: Prisma.TransactionClient, booking: Pick<Booking, "id" | "waiverRevision">) {
  return tx.waiverSignature.count({
    where: signedCountWhere(booking),
  });
}

async function activeGuestSigners(booking: Pick<Booking, "id" | "waiverRevision">) {
  const signatures = await prisma.waiverSignature.findMany({
    where: {
      ...signedCountWhere(booking),
      signerRole: "GUEST",
    },
    select: {
      signerName: true,
      signerEmail: true,
    },
    orderBy: { signedAt: "asc" },
  });

  const seen = new Set<string>();
  return signatures.filter((signature) => {
    const key = signature.signerEmail.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function audit(
  tx: Prisma.TransactionClient,
  input: {
    actorEmail: string;
    action: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.auditLog.create({
    data: {
      actorEmail: input.actorEmail,
      action: input.action,
      entityType: "Booking",
      entityId: input.entityId,
      before: input.before === undefined ? undefined : JSON.parse(JSON.stringify(input.before)),
      after: input.after === undefined ? undefined : JSON.parse(JSON.stringify(input.after)),
    },
  });
}

export async function markBookingConfirmedIfComplete(
  tx: Prisma.TransactionClient,
  booking: Booking,
  actorEmail: string,
) {
  const signedCount = await activeSignatureCount(tx, booking);

  if (signedCount < booking.playerCount || booking.status === "CONFIRMED") {
    return { booking, signedCount, confirmed: false };
  }

  const confirmed = await tx.booking.update({
    where: { id: booking.id },
    data: {
      status: "CONFIRMED",
      signatureConfirmedAt: new Date(),
      outlookSyncStatus: "PENDING",
      outlookSyncError: null,
    },
  });

  await audit(tx, {
    actorEmail,
    action: "BOOKING_SIGNATURES_COMPLETED",
    entityId: booking.id,
    before: booking,
    after: confirmed,
  });

  return { booking: confirmed, signedCount, confirmed: true };
}

export async function syncConfirmedBooking(input: {
  booking: Booking;
  baseUrl?: string;
  guestWaiverToken?: string;
}) {
  void input.baseUrl;
  void input.guestWaiverToken;
  const result = await createOutlookEvent(input.booking, organizerContact(input.booking));

  return prisma.booking.update({
    where: { id: input.booking.id },
    data: {
      outlookEventId: result.eventId ?? input.booking.outlookEventId,
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
  });
}

export async function cancelOutlookEventForPendingBooking(booking: Booking) {
  if (!booking.outlookEventId) return booking;

  const result = await deleteOutlookEvent(booking);

  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      outlookEventId: null,
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
  });
}

export function sendPendingSignatureNotice(input: {
  booking: Booking;
  manageUrl?: string;
  guestWaiverUrl?: string;
  signedCount: number;
}) {
  runAfterResponse(() =>
    sendOrganizerPendingSignatureEmail({
      booking: input.booking,
      signedCount: input.signedCount,
      manageUrl: input.manageUrl,
      guestWaiverUrl: input.guestWaiverUrl,
    }),
  );
}

export async function processSignatureDeadlines(input: {
  now?: Date;
  baseUrl?: string;
  limit?: number;
} = {}) {
  if (!appConfig.databaseConfigured) {
    return { reminded: 0, canceled: 0 };
  }

  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;
  const reminderUpperBound = new Date(now.getTime() + reminderLeadMs);

  const [reminderCandidates, cancelCandidates] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: "PENDING_SIGNATURES",
        signatureReminderSentAt: null,
        signatureDeadlineAt: {
          gt: now,
          lte: reminderUpperBound,
        },
      },
      include: {
        waiverSignatures: {
          select: { bookingRevision: true, emailStatus: true, status: true },
        },
      },
      orderBy: { signatureDeadlineAt: "asc" },
      take: limit,
    }),
    prisma.booking.findMany({
      where: {
        status: "PENDING_SIGNATURES",
        signatureDeadlineAt: { lte: now },
      },
      include: {
        waiverSignatures: {
          select: { bookingRevision: true, emailStatus: true, status: true },
        },
      },
      orderBy: { signatureDeadlineAt: "asc" },
      take: limit,
    }),
  ]);

  let reminded = 0;
  let canceled = 0;

  for (const booking of reminderCandidates) {
    const signedCount = booking.waiverSignatures.filter(
      (signature) => signature.bookingRevision === booking.waiverRevision && signature.status === "ACTIVE",
    ).length;

    if (signedCount >= booking.playerCount) continue;

    const saved = await prisma.booking.updateMany({
      where: {
        id: booking.id,
        status: "PENDING_SIGNATURES",
        signatureReminderSentAt: null,
      },
      data: {
        signatureReminderSentAt: now,
      },
    });

    if (saved.count === 0) continue;
    reminded += 1;

    await prisma.auditLog.create({
      data: {
        actorEmail: "system",
        action: "BOOKING_SIGNATURE_REMINDER_SENT",
        entityType: "Booking",
        entityId: booking.id,
        after: {
          signatureReminderSentAt: now.toISOString(),
          waiverSignedCount: signedCount,
        },
      },
    });

    runAfterResponse(() =>
      sendOrganizerSignatureReminderEmail({
        booking,
        signedCount,
      }),
    );
  }

  for (const booking of cancelCandidates) {
    const result = await retryPrismaTransaction(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.booking.findUnique({
            where: { id: booking.id },
            include: {
              waiverSignatures: {
                select: { bookingRevision: true, emailStatus: true, status: true },
              },
            },
          });

          if (!current || current.status !== "PENDING_SIGNATURES") {
            return null;
          }

          const signedCount = current.waiverSignatures.filter(
            (signature) => signature.bookingRevision === current.waiverRevision && signature.status === "ACTIVE",
          ).length;

          if (signedCount >= current.playerCount) {
            return null;
          }

          const saved = await tx.booking.update({
            where: { id: current.id },
            data: {
              status: "CANCELED",
              autoCanceledAt: now,
              outlookSyncStatus: current.outlookEventId ? current.outlookSyncStatus : "SKIPPED",
            },
          });

          await audit(tx, {
            actorEmail: "system",
            action: "BOOKING_AUTO_CANCELED_SIGNATURES",
            entityId: current.id,
            before: current,
            after: saved,
          });

          return { booking: saved, signedCount };
        },
        { isolationLevel: "Serializable" },
      ),
    );

    if (!result) continue;
    canceled += 1;

    const guestSigners = await activeGuestSigners(result.booking);
    runAfterResponse(async () => {
      const canceledBooking = result.booking.outlookEventId
        ? await cancelOutlookEventForPendingBooking(result.booking)
        : result.booking;

      await sendOrganizerAutoCanceledEmail({
        booking: canceledBooking,
        signedCount: result.signedCount,
      });

      await notifyGuestsCanceled(canceledBooking, guestSigners);
    });
  }

  return { reminded, canceled };
}

async function notifyGuestsCanceled(booking: Booking, guests: GuestSigner[]) {
  await Promise.all(
    guests.map(async (guest) => {
      try {
        await sendGuestBookingCanceledEmail({
          booking,
          signerName: guest.signerName,
          signerEmail: guest.signerEmail,
        });
      } catch {
        // La cancellazione automatica resta valida anche se una notifica accessoria fallisce.
      }
    }),
  );
}
