import type { Booking, Prisma, WaiverEmailStatus } from "@prisma/client";
import { BookingStatus, Prisma as PrismaNamespace } from "@prisma/client";
import { runAfterResponse } from "@/lib/after-response";
import { auditJson } from "@/lib/audit-sanitizer";
import { AppError } from "@/lib/errors";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";
import { availabilityOrganizerLabel } from "@/lib/booking-copy";
import { appConfig } from "@/lib/config";
import {
  demoCancelBooking,
  demoCreateAdminBlock,
  demoCreateBooking,
  demoDeleteAdminBlock,
  demoGetAdminAudit,
  demoGetAvailability,
  demoListBookings,
  demoLookupBookings,
  demoUpdateBooking,
} from "@/lib/demo-store";
import {
  deleteOutlookEvent,
  sendGuestBookingCanceledEmail,
  sendGuestBookingUpdatedEmail,
  sendOrganizerBookingCanceledEmail,
  updateOutlookEvent,
  type BookingCancelActor,
} from "@/lib/graph";
import {
  createManageToken,
  hashManageToken,
  isManageTokenValid,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import { prisma } from "@/lib/prisma";
import { retryPrismaTransaction } from "@/lib/prisma-retry";
import { assertDateParam, zonedDayBounds } from "@/lib/time";
import {
  buildGuestWaiverUrl,
  createGuestWaiverToken,
  createWaiverSignature,
  guestWaiverTokenData,
  sendOrganizerPendingSignatureWithWaiver,
  sendWaiverSignatureEmail,
  summarizeWaiverSignatures,
  validatePlayerCount,
  type WaiverEvidence,
  type WaiverInput,
} from "@/lib/waiver-service";
import {
  cancelOutlookEventForPendingBooking,
  markBookingConfirmedIfComplete,
  runOpportunisticSignatureDeadlines,
  sendPendingSignatureNotice,
  signatureDeadlineAt,
  syncConfirmedBooking,
} from "@/lib/signature-workflow";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";

type AuditActor = {
  id?: string | null;
  email: string;
};

export type PublicBookingInput = {
  start: Date;
  end: Date;
  organizerName: string;
  organizerEmail: string;
  playerCount: number;
  waiver: WaiverInput;
  waiverEvidence?: WaiverEvidence;
  baseUrl?: string;
};

export type BookingAccess = {
  adminUser?: CurrentUser | null;
  manageToken?: string | null;
  baseUrl?: string;
};

function buildManageUrl(baseUrl: string | undefined, bookingId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  return `${baseUrl.replace(/\/$/, "")}/manage/${bookingId}?${params.toString()}`;
}

type BookingWithWaiverSignatures = Booking & {
  waiverSignatures?: Array<{ bookingRevision: number; emailStatus: WaiverEmailStatus; status?: "ACTIVE" | "CANCELED" }>;
};

function serializeBooking(booking: BookingWithWaiverSignatures): AvailabilityBooking {
  const waiverSummary = summarizeWaiverSignatures(booking);

  return {
    id: booking.id,
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    status: booking.status,
    organizerName: booking.organizerName,
    outlookSyncStatus: booking.outlookSyncStatus,
    playerCount: booking.playerCount,
    waiverSignedCount: waiverSummary.signedCount,
    waiverEmailStatus: waiverSummary.emailStatus,
    signatureDeadlineAt: booking.signatureDeadlineAt?.toISOString() ?? null,
    signatureConfirmedAt: booking.signatureConfirmedAt?.toISOString() ?? null,
    autoCanceledAt: booking.autoCanceledAt?.toISOString() ?? null,
  };
}

function serializeManagedBooking(
  booking: BookingWithWaiverSignatures,
  manageToken?: string,
  baseUrl?: string,
  guestWaiverToken?: string,
): MyBooking {
  return {
    ...serializeBooking(booking),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    manageToken,
    manageUrl: buildManageUrl(baseUrl, booking.id, manageToken),
    guestWaiverToken,
    guestWaiverUrl: buildGuestWaiverUrl(baseUrl, booking.id, guestWaiverToken),
  };
}

function serializeBlock(block: {
  id: string;
  start: Date;
  end: Date;
  reason: string;
}): AvailabilityBlock {
  return {
    id: block.id,
    start: block.start.toISOString(),
    end: block.end.toISOString(),
    reason: block.reason,
  };
}

async function audit(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await tx.auditLog.create({
    data: {
      actorId: actor.id ?? null,
      actorEmail: actor.email,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before === undefined ? undefined : auditJson(input.before),
      after: input.after === undefined ? undefined : auditJson(input.after),
    },
  });
}

function bookingOrganizer(booking: Booking) {
  return {
    email: booking.organizerEmail,
    name: booking.organizerName,
  };
}

async function syncBooking(booking: Booking, manageToken?: string, baseUrl?: string) {
  const manageUrl = buildManageUrl(baseUrl, booking.id, manageToken);
  const result = await updateOutlookEvent(booking, bookingOrganizer(booking), manageUrl);

  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      outlookEventId: result.eventId ?? booking.outlookEventId,
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
  });
}

async function markOutlookDeleted(booking: Booking) {
  const result = await deleteOutlookEvent(booking);

  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
  });
}

type GuestSignatureForNotice = {
  signerName: string;
  signerEmail: string;
};

function uniqueGuestSigners(signatures: GuestSignatureForNotice[]) {
  const seen = new Set<string>();
  return signatures.filter((signature) => {
    const key = signature.signerEmail.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function activeGuestSignersForBooking(
  booking: Pick<Booking, "id" | "waiverRevision">,
): Promise<GuestSignatureForNotice[]> {
  const signatures = await prisma.waiverSignature.findMany({
    where: {
      bookingId: booking.id,
      bookingRevision: booking.waiverRevision,
      signerRole: "GUEST",
      status: "ACTIVE",
    },
    select: {
      signerName: true,
      signerEmail: true,
    },
    orderBy: { signedAt: "asc" },
  });

  return uniqueGuestSigners(signatures);
}

async function notifyGuestSignersOfUpdate(input: {
  previousBooking: Booking;
  booking: Booking;
  guests: GuestSignatureForNotice[];
  guestWaiverUrl?: string;
}) {
  await Promise.all(
    input.guests.map(async (guest) => {
      try {
        await sendGuestBookingUpdatedEmail({
          previousBooking: input.previousBooking,
          booking: input.booking,
          signerName: guest.signerName,
          signerEmail: guest.signerEmail,
          guestWaiverUrl: input.guestWaiverUrl,
        });
      } catch {
        // La modifica prenotazione non deve fallire se una notifica accessoria non parte.
      }
    }),
  );
}

async function notifyGuestSignersOfCancellation(
  booking: Booking,
  guests: GuestSignatureForNotice[],
) {
  await Promise.all(
    guests.map(async (guest) => {
      try {
        await sendGuestBookingCanceledEmail({
          booking,
          signerName: guest.signerName,
          signerEmail: guest.signerEmail,
        });
      } catch {
        // La cancellazione prenotazione resta valida anche se una notifica accessoria fallisce.
      }
    }),
  );
}

// Il referente e' l'unico a non sapere nulla del proprio annullamento: gli ospiti che avevano
// firmato ricevono la loro mail, lui no. Riceve sempre una ricevuta, con testo diverso a seconda
// di chi ha annullato; l'identita' personale dell'admin non compare mai, e' un requisito.
function bookingCancelActor(access: BookingAccess, booking: Booking): BookingCancelActor {
  if (access.adminUser?.role !== "ADMIN") return "organizer";
  return normalizeEmail(access.adminUser.email) === normalizeEmail(booking.organizerEmail)
    ? "organizer"
    : "admin";
}

async function notifyOrganizerOfCancellation(booking: Booking, actor: BookingCancelActor) {
  try {
    await sendOrganizerBookingCanceledEmail({ booking, actor });
  } catch {
    // La cancellazione prenotazione resta valida anche se una notifica accessoria fallisce.
  }
}

async function getBookingWithWaivers(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true, status: true },
      },
    },
  });
}

export function shouldRetryOutlookDelete(
  booking: Pick<Booking, "status" | "outlookEventId" | "outlookSyncStatus">,
) {
  return (
    booking.status === "CANCELED" &&
    Boolean(booking.outlookEventId) &&
    booking.outlookSyncStatus !== "SYNCED" &&
    booking.outlookSyncStatus !== "SKIPPED"
  );
}

function normalizePublicBookingInput(input: PublicBookingInput) {
  const organizerName = normalizePersonName(input.organizerName);
  const organizerEmail = normalizeEmail(input.organizerEmail);
  const playerCount = validatePlayerCount(input.playerCount);
  const errors: string[] = [];

  if (organizerName.split(" ").filter(Boolean).length < 2) {
    errors.push("Inserisci nome e cognome.");
  }

  if (organizerName.length > 80) {
    errors.push("Nome e cognome sono troppo lunghi.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(organizerEmail)) {
    errors.push("Inserisci un'email valida.");
  }

  if (organizerEmail.length > 120) {
    errors.push("L'email è troppo lunga.");
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(" "), 422);
  }

  return { organizerName, organizerEmail, playerCount };
}

async function validateNoConflicts(
  tx: Prisma.TransactionClient,
  input: {
    start: Date;
    end: Date;
    organizerEmail: string;
    ignoreBookingId?: string;
  },
) {
  const now = new Date();
  const activeBookingWhere: Prisma.BookingWhereInput = {
    OR: [
      { status: "CONFIRMED" },
      {
        status: "PENDING_SIGNATURES",
        OR: [{ signatureDeadlineAt: null }, { signatureDeadlineAt: { gt: now } }],
      },
    ],
  };
  const [futureBookingCount, overlappingBookings, overlappingBlocks] = await Promise.all([
    tx.booking.count({
      where: {
        AND: [activeBookingWhere],
        organizerEmail: input.organizerEmail,
        end: { gte: new Date() },
        id: input.ignoreBookingId ? { not: input.ignoreBookingId } : undefined,
      },
    }),
    tx.booking.findMany({
      where: {
        AND: [activeBookingWhere],
        id: input.ignoreBookingId ? { not: input.ignoreBookingId } : undefined,
        start: { lt: input.end },
        end: { gt: input.start },
      },
      select: { id: true },
    }),
    tx.adminBlock.findMany({
      where: {
        start: { lt: input.end },
        end: { gt: input.start },
      },
      select: { id: true },
    }),
  ]);

  const errors = validateBookingPolicy({
    start: input.start,
    end: input.end,
    futureBookingCount,
  });

  if (overlappingBookings.length > 0) {
    errors.push("Il campo è già prenotato in quella fascia.");
  }

  if (overlappingBlocks.length > 0) {
    errors.push("Il campo è bloccato dall'admin in quella fascia.");
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(" "), 422);
  }
}

function assertBookingAccess(booking: Booking, access: BookingAccess): AuditActor {
  if (access.adminUser?.role === "ADMIN") {
    return {
      id: access.adminUser.id,
      email: access.adminUser.email,
    };
  }

  if (isManageTokenValid(booking, access.manageToken)) {
    return { email: booking.organizerEmail };
  }

  throw new AppError("Link di gestione non valido o scaduto.", 403);
}

// Il calendario e' pubblico, ma l'admin (unico contesto autenticato che rende questa griglia)
// deve vedere il nome intero: passiamo il viewer cosi' la stessa query serve entrambi i pubblici
// senza esporre il cognome a chi non e' admin.
export type AvailabilityViewer = { role?: CurrentUser["role"] | null } | null;

export async function getAvailability(dateValue: string | null, viewer?: AvailabilityViewer) {
  if (!appConfig.databaseConfigured) {
    return demoGetAvailability(dateValue, viewer);
  }

  await runOpportunisticSignatureDeadlines();
  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);
  const now = new Date();

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        start: { lt: bounds.end },
        end: { gt: bounds.start },
        OR: [
          { status: "CONFIRMED" },
          {
            status: "PENDING_SIGNATURES",
            OR: [{ signatureDeadlineAt: null }, { signatureDeadlineAt: { gt: now } }],
          },
        ],
      },
      include: {
        waiverSignatures: {
          select: { bookingRevision: true, emailStatus: true, status: true },
        },
      },
      orderBy: { start: "asc" },
    }),
    prisma.adminBlock.findMany({
      where: {
        start: { lt: bounds.end },
        end: { gt: bounds.start },
      },
      orderBy: { start: "asc" },
    }),
  ]);

  return {
    date,
    settings: {
      ...bookingPolicy,
      allowedDomain: appConfig.allowedDomain,
    },
    bookings: bookings.map((booking) => ({
      ...serializeBooking(booking),
      organizerName: availabilityOrganizerLabel(booking.organizerName, viewer?.role),
    })),
    blocks: blocks.map(serializeBlock),
  };
}

export async function lookupBookings(tokens: string[], baseUrl?: string) {
  if (!appConfig.databaseConfigured) {
    return demoLookupBookings(tokens, baseUrl);
  }

  await runOpportunisticSignatureDeadlines({ baseUrl });
  const cleanTokens = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].slice(0, 30);
  const tokenByHash = new Map(cleanTokens.map((token) => [hashManageToken(token), token]));
  const hashes = [...tokenByHash.keys()];

  if (!hashes.length) return [];

  const now = new Date();
  const bookings = await prisma.booking.findMany({
    where: {
      manageTokenHash: { in: hashes },
      manageTokenExpiresAt: { gt: now },
      OR: [{ end: { gte: now } }, { status: "CANCELED" }],
    },
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true, status: true },
      },
    },
    orderBy: [{ status: "asc" }, { start: "asc" }],
    take: 30,
  });

  return bookings.map((booking) =>
    serializeManagedBooking(
      booking,
      booking.manageTokenHash ? tokenByHash.get(booking.manageTokenHash) : undefined,
      baseUrl,
    ),
  );
}

export async function listBookings(currentUser: CurrentUser) {
  if (!appConfig.databaseConfigured) {
    return demoListBookings(currentUser);
  }

  const bookings = await prisma.booking.findMany({
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true, status: true },
      },
    },
    orderBy: { start: "desc" },
    take: 100,
  });

  return bookings.map((booking) => serializeManagedBooking(booking));
}

export async function createBooking(input: PublicBookingInput) {
  if (!appConfig.databaseConfigured) {
    return demoCreateBooking(input);
  }

  await runOpportunisticSignatureDeadlines({ baseUrl: input.baseUrl });
  const identity = normalizePublicBookingInput(input);
  const manageToken = createManageToken();
  const manageTokenHash = hashManageToken(manageToken);
  const tokenExpiresAt = manageTokenExpiresAt(input.end);
  const guestWaiverToken = identity.playerCount > 1 ? createGuestWaiverToken() : undefined;
  const guestWaiverData = guestWaiverToken ? guestWaiverTokenData(guestWaiverToken, input.end) : {};
  const createdAt = new Date();
  const deadlineAt = signatureDeadlineAt(input.start, createdAt);

  const result = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        await validateNoConflicts(tx, {
          start: input.start,
          end: input.end,
          organizerEmail: identity.organizerEmail,
        });

        const created = await tx.booking.create({
          data: {
            start: input.start,
            end: input.end,
            status: "PENDING_SIGNATURES",
            organizerName: identity.organizerName,
            organizerEmail: identity.organizerEmail,
            playerCount: identity.playerCount,
            manageTokenHash,
            manageTokenExpiresAt: tokenExpiresAt,
            signatureDeadlineAt: deadlineAt,
            signatureWindowStartedAt: createdAt,
            ...guestWaiverData,
            outlookSyncStatus: "SKIPPED",
          },
        });

        const organizerWaiver = await createWaiverSignature(
          tx,
          created,
          input.waiver,
          "ORGANIZER",
          input.waiverEvidence ?? {},
        );

        await audit(tx, { email: identity.organizerEmail }, {
          action: "BOOKING_CREATED",
          entityType: "Booking",
          entityId: created.id,
          after: created,
        });

        await audit(tx, { email: identity.organizerEmail }, {
          action: "WAIVER_SIGNED",
          entityType: "WaiverSignature",
          entityId: organizerWaiver.id,
          after: {
            bookingId: created.id,
            bookingRevision: created.waiverRevision,
            signerRole: "ORGANIZER",
            signerEmail: organizerWaiver.signerEmail,
            signatureImageSha256: organizerWaiver.signatureImageSha256,
            pdfSha256: organizerWaiver.pdfSha256,
          },
        });

        const confirmation = await markBookingConfirmedIfComplete(tx, created, organizerWaiver.signerEmail);

        return {
          booking: confirmation.confirmed ? confirmation.booking : created,
          organizerWaiverId: organizerWaiver.id,
          confirmedBooking: confirmation.confirmed ? confirmation.booking : null,
        };
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  // Email e Microsoft Graph sono step lenti: li eseguiamo dopo la risposta. Una prenotazione da
  // un giocatore nasce confermata: l'avviso di attesa firme non parte, quindi il PDF al
  // referente ha bisogno della sua mail come sempre. Negli altri casi l'avviso si porta dietro
  // il PDF e la copia separata sparisce: al referente arriva una mail sola.
  const pendingNoticeCarriesWaiver = result.booking.status === "PENDING_SIGNATURES";
  runAfterResponse(async () => {
    // L'archivio ha il suo try, e le due mail restano in fila nello stesso task perche' l'ordine
    // di arrivo (prima l'archivio, poi il referente) e' voluto. sendWaiverSignatureEmail ingoia
    // gli errori Graph e li scrive come FAILED, ma non il 404 della riga che non si trova ne' un
    // blip del DB sulla update: senza questo catch l'eccezione si porterebbe via l'avviso di
    // attesa firme, cioe' l'unica copia del link firma ospiti che il referente riceve. Nessuno
    // firmerebbe, la partita morirebbe alla scadenza, e col cron in silenzio (start passato) il
    // referente non saprebbe nemmeno perche'.
    try {
      await sendWaiverSignatureEmail(
        result.organizerWaiverId,
        pendingNoticeCarriesWaiver ? ["archive"] : undefined,
      );
    } catch {
      // L'esito dell'archivio e' gia' scritto sulla riga: qui si protegge solo la mail che segue.
    }

    if (pendingNoticeCarriesWaiver) {
      await sendOrganizerPendingSignatureWithWaiver({
        signatureId: result.organizerWaiverId,
        booking: result.booking,
        manageUrl: buildManageUrl(input.baseUrl, result.booking.id, manageToken),
        guestWaiverUrl: buildGuestWaiverUrl(input.baseUrl, result.booking.id, guestWaiverToken),
        signedCount: 1,
      });
      return;
    }

    if (result.confirmedBooking) {
      await syncConfirmedBooking({
        booking: result.confirmedBooking,
        manageUrl: buildManageUrl(input.baseUrl, result.booking.id, manageToken),
      });
    }
  });

  const refreshed = await getBookingWithWaivers(result.booking.id);
  return serializeManagedBooking(refreshed ?? result.booking, manageToken, input.baseUrl, guestWaiverToken);
}

export async function updateBooking(
  access: BookingAccess,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: BookingStatus; playerCount?: number },
) {
  if (!appConfig.databaseConfigured) {
    return demoUpdateBooking(access, bookingId, input);
  }

  await runOpportunisticSignatureDeadlines({ baseUrl: access.baseUrl });
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      waiverSignatures: {
        select: { bookingRevision: true, emailStatus: true, status: true },
      },
    },
  });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const actor = assertBookingAccess(booking, access);
  const isAdmin = access.adminUser?.role === "ADMIN";

  if (input.status && !isAdmin) {
    throw new AppError("Usa il comando cancella per annullare la prenotazione.", 403);
  }

  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;
  const nextPlayerCount = input.playerCount === undefined ? booking.playerCount : validatePlayerCount(input.playerCount);
  const timeChanged =
    nextStart.getTime() !== booking.start.getTime() ||
    nextEnd.getTime() !== booking.end.getTime();
  const playerCountChanged = nextPlayerCount !== booking.playerCount;
  const slotOrPlayerCountChanged = timeChanged || playerCountChanged;
  const currentWaiverSummary = summarizeWaiverSignatures(booking);
  const canConfirmSinglePlayerWithCurrentSignature =
    !timeChanged &&
    nextPlayerCount === 1 &&
    currentWaiverSummary.signedCount >= 1 &&
    input.status === undefined;
  const nextStatus = input.status ??
    (slotOrPlayerCountChanged
      ? canConfirmSinglePlayerWithCurrentSignature
        ? "CONFIRMED"
        : "PENDING_SIGNATURES"
      : booking.status);
  const requiresFreshWaivers =
    slotOrPlayerCountChanged && nextStatus !== "CANCELED" && !canConfirmSinglePlayerWithCurrentSignature;

  // Il manage token vive fino a end+24h: senza questo controllo si puo' riprogrammare una
  // partita gia' giocata, il che invalida le firme reali e la fa annullare a posteriori,
  // lasciando gli scarichi di responsabilita' appesi a uno slot annullato. La cancellazione
  // resta permessa: e' solo lo spostamento a produrre il danno.
  if (requiresFreshWaivers && booking.start <= new Date() && !isAdmin) {
    throw new AppError("La partita è già iniziata: non è più modificabile.", 409);
  }
  const isCancellation = booking.status !== "CANCELED" && nextStatus === "CANCELED";
  const nextGuestWaiverToken = requiresFreshWaivers ? createGuestWaiverToken() : undefined;
  const guestSignersToNotify =
    requiresFreshWaivers || isCancellation ? await activeGuestSignersForBooking(booking) : [];

  const updated = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        if (nextStatus === "CONFIRMED" || nextStatus === "PENDING_SIGNATURES") {
          await validateNoConflicts(tx, {
            start: nextStart,
            end: nextEnd,
            organizerEmail: booking.organizerEmail,
            ignoreBookingId: booking.id,
          });
        }

        const saved = await tx.booking.update({
          where: { id: booking.id },
          data: {
            start: nextStart,
            end: nextEnd,
            status: nextStatus,
            playerCount: nextPlayerCount,
            manageTokenExpiresAt: manageTokenExpiresAt(nextEnd),
            ...(nextGuestWaiverToken
              ? {
                  waiverRevision: { increment: 1 },
                  ...guestWaiverTokenData(nextGuestWaiverToken, nextEnd),
                }
              : {}),
            ...(requiresFreshWaivers
              ? {
                  signatureDeadlineAt: signatureDeadlineAt(nextStart),
                  signatureWindowStartedAt: new Date(),
                  signatureReminderSentAt: null,
                  signatureConfirmedAt: null,
                  autoCanceledAt: null,
                }
              : canConfirmSinglePlayerWithCurrentSignature
                ? {
                    signatureReminderSentAt: null,
                    signatureConfirmedAt: booking.signatureConfirmedAt ?? new Date(),
                    autoCanceledAt: null,
                  }
              : {}),
            outlookSyncStatus:
              nextStatus === "CONFIRMED"
                ? "PENDING"
                : requiresFreshWaivers
                  ? booking.outlookEventId
                    ? "PENDING"
                    : "SKIPPED"
                  : booking.outlookSyncStatus,
          },
        });

        await audit(tx, actor, {
          action: nextStatus === "CONFIRMED" ? "BOOKING_UPDATED" : "BOOKING_STATUS_CHANGED",
          entityType: "Booking",
          entityId: booking.id,
          before: booking,
          after: saved,
        });

        return saved;
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  // Sync Outlook e notifiche ospiti (Microsoft Graph) sono gli step lenti: dopo la risposta.
  runAfterResponse(async () => {
    if (isCancellation) {
      const synced = await markOutlookDeleted(updated);
      if (guestSignersToNotify.length > 0) {
        await notifyGuestSignersOfCancellation(synced, guestSignersToNotify);
      }
      await notifyOrganizerOfCancellation(synced, bookingCancelActor(access, booking));
      return;
    }

    if (requiresFreshWaivers) {
      const pending = await cancelOutlookEventForPendingBooking(updated);
      sendPendingSignatureNotice({
        booking: pending,
        manageUrl: buildManageUrl(access.baseUrl, pending.id, access.manageToken ?? undefined),
        guestWaiverUrl: buildGuestWaiverUrl(access.baseUrl ?? appConfig.publicOrigin, pending.id, nextGuestWaiverToken),
        signedCount: 0,
      });

      if (guestSignersToNotify.length > 0) {
        await notifyGuestSignersOfUpdate({
          previousBooking: booking,
          booking: pending,
          guests: guestSignersToNotify,
          guestWaiverUrl: buildGuestWaiverUrl(
            access.baseUrl ?? appConfig.publicOrigin,
            pending.id,
            nextGuestWaiverToken,
          ),
        });
      }
      return;
    }

    if (updated.status === "CONFIRMED") {
      await syncBooking(updated, access.manageToken ?? undefined, access.baseUrl);
    } else if (updated.status === "PENDING_SIGNATURES") {
      await cancelOutlookEventForPendingBooking(updated);
    }
  });

  const refreshed = await getBookingWithWaivers(updated.id);
  return serializeManagedBooking(
    refreshed ?? updated,
    access.manageToken ?? undefined,
    access.baseUrl,
    nextGuestWaiverToken,
  );
}

export async function cancelBooking(access: BookingAccess, bookingId: string) {
  if (!appConfig.databaseConfigured) {
    return demoCancelBooking(access, bookingId);
  }

  await runOpportunisticSignatureDeadlines({ baseUrl: access.baseUrl });
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const actor = assertBookingAccess(booking, access);

  if (booking.status === "CANCELED") {
    if (shouldRetryOutlookDelete(booking)) {
      runAfterResponse(() => markOutlookDeleted(booking));
    }

    const refreshed = await getBookingWithWaivers(booking.id);
    return serializeManagedBooking(refreshed ?? booking, access.manageToken ?? undefined, access.baseUrl);
  }

  const guestSignersToNotify = await activeGuestSignersForBooking(booking);

  const canceled = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const saved = await tx.booking.update({
          where: { id: booking.id },
          data: { status: "CANCELED" },
        });

        await audit(tx, actor, {
          action: "BOOKING_CANCELED",
          entityType: "Booking",
          entityId: booking.id,
          before: booking,
          after: saved,
        });

        return saved;
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  runAfterResponse(async () => {
    const synced = await markOutlookDeleted(canceled);
    if (guestSignersToNotify.length > 0) {
      await notifyGuestSignersOfCancellation(synced, guestSignersToNotify);
    }
    await notifyOrganizerOfCancellation(synced, bookingCancelActor(access, booking));
  });

  const refreshed = await getBookingWithWaivers(canceled.id);
  return serializeManagedBooking(refreshed ?? canceled, access.manageToken ?? undefined, access.baseUrl);
}

export async function createAdminBlock(
  currentUser: CurrentUser,
  input: { start: Date; end: Date; reason: string },
) {
  if (!appConfig.databaseConfigured) {
    return demoCreateAdminBlock(currentUser, input);
  }

  await runOpportunisticSignatureDeadlines();

  if (input.start >= input.end) {
    throw new AppError("Il blocco deve avere un orario di fine valido.", 422);
  }

  if (!isAlignedToSlot(input.start) || !isAlignedToSlot(input.end)) {
    throw new AppError("Il blocco deve usare step da 15 minuti.", 422);
  }

  if (!input.reason.trim()) {
    throw new AppError("Inserisci un motivo per il blocco.", 422);
  }

  const block = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const overlappingBookings = await tx.booking.findMany({
          where: {
            start: { lt: input.end },
            end: { gt: input.start },
            OR: [
              { status: "CONFIRMED" },
              {
                status: "PENDING_SIGNATURES",
                OR: [{ signatureDeadlineAt: null }, { signatureDeadlineAt: { gt: now } }],
              },
            ],
          },
          select: { id: true },
        });

        if (overlappingBookings.length > 0) {
          throw new AppError(
            "Ci sono prenotazioni attive in questa fascia. Cancellale o spostale prima.",
            422,
          );
        }

        const saved = await tx.adminBlock.create({
          data: {
            start: input.start,
            end: input.end,
            reason: input.reason.trim(),
            createdById: currentUser.id,
          },
        });

        await audit(tx, currentUser, {
          action: "ADMIN_BLOCK_CREATED",
          entityType: "AdminBlock",
          entityId: saved.id,
          after: saved,
        });

        return saved;
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  return serializeBlock(block);
}

export async function deleteAdminBlock(currentUser: CurrentUser, blockId: string) {
  if (!appConfig.databaseConfigured) {
    return demoDeleteAdminBlock(currentUser, blockId);
  }

  const block = await prisma.adminBlock.findUnique({ where: { id: blockId } });

  if (!block) {
    throw new AppError("Blocco non trovato.", 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.adminBlock.delete({ where: { id: block.id } });
    await audit(tx, currentUser, {
      action: "ADMIN_BLOCK_DELETED",
      entityType: "AdminBlock",
      entityId: block.id,
      before: block,
    });
  });

  return { id: block.id };
}

export async function getAdminAudit(): Promise<AuditItem[]> {
  if (!appConfig.databaseConfigured) {
    return demoGetAdminAudit();
  }

  const items = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  return items.map((item) => ({
    id: item.id,
    actorEmail: item.actorEmail,
    action: item.action,
    entityType: item.entityType,
    entityId: item.entityId,
    createdAt: item.createdAt.toISOString(),
  }));
}

export function hasRangeConflict(
  start: Date,
  end: Date,
  ranges: Array<{ start: Date; end: Date }>,
) {
  return ranges.some((range) => rangesOverlap(start, end, range.start, range.end));
}
