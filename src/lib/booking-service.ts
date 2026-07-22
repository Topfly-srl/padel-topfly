import type { Booking, Prisma, WaiverEmailStatus } from "@/generated/prisma/client";
import { BookingStatus, Prisma as PrismaNamespace } from "@/generated/prisma/client";
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
  demoGetAdminStats,
  demoGetAvailability,
  demoListBookings,
  demoLookupBookings,
  demoUpdateBooking,
} from "@/lib/demo-store";
import {
  statsWeekWindowStart,
  summarizeCancellations,
  summarizeStartHours,
  summarizeStatuses,
  summarizeWeeks,
} from "@/lib/admin-stats";
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
import { normalizeCancelReason } from "@/lib/cancel-reason";
import type {
  AdminStats,
  AuditAction,
  AuditPage,
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
    // La causale resta fuori dal payload pubblico (serializeBooking): compare solo dove serve un
    // token di gestione o l'admin, cioe' esattamente dove una prenotazione annullata e' visibile.
    cancelReason: booking.cancelReason ?? null,
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

  // Task post-risposta su snapshot: la scrittura pretende che la prenotazione sia ancora
  // CONFIRMED (syncBooking parte solo da li'). Se nel frattempo e' stata annullata, un evento
  // creato ex novo dal fallback di updateOutlookEvent va compensato, non registrato.
  const guard = await prisma.booking.updateMany({
    where: { id: booking.id, status: "CONFIRMED" },
    data: {
      outlookEventId: result.eventId ?? booking.outlookEventId,
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
  });

  if (guard.count === 0 && result.eventId && result.eventId !== booking.outlookEventId) {
    // Stessa compensazione di syncConfirmedBooking: commento coerente allo stato reale e, se
    // anche la compensazione fallisce, l'id orfano resta tracciato sulla riga (soli campi
    // Outlook) cosi' i percorsi idempotenti di cancellazione possono ritentare.
    const current = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    const cleanup = await deleteOutlookEvent(
      { ...current, outlookEventId: result.eventId },
      current.status === "PENDING_SIGNATURES" ? "pending" : "canceled",
    );

    if (cleanup.status === "FAILED") {
      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          outlookEventId: result.eventId,
          outlookSyncStatus: "FAILED",
          outlookSyncError: cleanup.error ?? null,
        },
      });
    }
  }

  return prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
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
  // Dentro una transazione va passato il client tx: leggere con `prisma` da dentro una
  // serializable vanificherebbe la coerenza tra guardia di stato e lista da avvisare.
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<GuestSignatureForNotice[]> {
  const signatures = await db.waiverSignature.findMany({
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
    enforceEndOfDay?: boolean;
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
    enforceEndOfDay: input.enforceEndOfDay,
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
  input: { start?: Date; end?: Date; status?: BookingStatus; playerCount?: number; cancelReason?: string | null },
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

  // Una prenotazione annullata non e' "riattivabile" dal referente: senza questo rifiuto un tab
  // rimasto aperto sulla pagina di gestione potrebbe salvare uno spostamento e farla risorgere
  // con una nuova scadenza firme. La riattivazione resta un gesto deliberato e solo admin.
  if (booking.status === "CANCELED" && !isAdmin) {
    throw new AppError("La prenotazione è stata annullata: non è più modificabile.", 409);
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
  // La causale vive solo su una prenotazione annullata: la scrivo quando l'annullamento avviene e la
  // azzero quando lo stato torna attivo (riprogrammazione admin), cosi' non resta un motivo stantio
  // appeso a uno slot di nuovo valido. Se lo stato resta CANCELED senza transizione, non la tocco.
  const cancelReasonData =
    isCancellation
      ? { cancelReason: normalizeCancelReason(input.cancelReason) }
      : nextStatus !== "CANCELED"
        ? { cancelReason: null }
        : {};
  const nextGuestWaiverToken = requiresFreshWaivers ? createGuestWaiverToken() : undefined;

  const { updated, guestSignersToNotify } = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        if (nextStatus === "CONFIRMED" || nextStatus === "PENDING_SIGNATURES") {
          await validateNoConflicts(tx, {
            start: nextStart,
            end: nextEnd,
            organizerEmail: booking.organizerEmail,
            ignoreBookingId: booking.id,
            // Solo lo spostamento su un nuovo slot va vincolato alla mezzanotte: una prenotazione
            // esistente resta modificabile finche' non si cambia l'orario.
            enforceEndOfDay: timeChanged,
          });
        }

        // Tutte le decisioni (nextStatus, firme, notifiche) sono calcolate sullo snapshot letto
        // fuori dalla transazione: la scrittura pretende quindi che la riga sia ANCORA quella
        // dello snapshot (stato E updatedAt). Senza la guardia sullo stato, un annullamento
        // concorrente (o un retry dopo un conflitto di serializzazione) farebbe "resuscitare"
        // una prenotazione annullata; senza quella su updatedAt, due modifiche concorrenti che
        // non cambiano stato si sovrascriverebbero in silenzio (lost update). La riattivazione
        // admin resta possibile: parte da uno snapshot appena letto, quindi la guardia combacia.
        const guard = await tx.booking.updateMany({
          where: { id: booking.id, status: booking.status, updatedAt: booking.updatedAt },
          data: {
            start: nextStart,
            end: nextEnd,
            status: nextStatus,
            playerCount: nextPlayerCount,
            ...cancelReasonData,
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
            // Ogni CONFIRMED forzato dall'admin rinnova l'istante di conferma: e' anche la
            // componente della chiave di idempotenza Graph, che deve cambiare a ogni riconferma
            // (altrimenti Graph dedupe restituirebbe un evento gia' cancellato in passato).
            ...(input.status === "CONFIRMED"
              ? { signatureConfirmedAt: new Date(), autoCanceledAt: null }
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

        if (guard.count === 0) {
          throw new AppError(
            "La prenotazione è stata modificata nel frattempo: ricarica la pagina e riprova.",
            409,
          );
        }

        const saved = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });

        // La lista di chi avvisare va letta con la stessa transazione che ha vinto la guardia:
        // letta prima, potrebbe appartenere a una revisione firme ormai superata.
        const guestSigners =
          requiresFreshWaivers || isCancellation
            ? await activeGuestSignersForBooking(booking, tx)
            : [];

        await audit(tx, actor, {
          action: nextStatus === "CONFIRMED" ? "BOOKING_UPDATED" : "BOOKING_STATUS_CHANGED",
          entityType: "Booking",
          entityId: booking.id,
          before: booking,
          after: saved,
        });

        return { updated: saved, guestSignersToNotify: guestSigners };
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

export async function cancelBooking(
  access: BookingAccess,
  bookingId: string,
  input: { cancelReason?: string | null } = {},
) {
  if (!appConfig.databaseConfigured) {
    return demoCancelBooking(access, bookingId, input);
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

  const result = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        // Due annullamenti in gara (referente su due dispositivi, o referente+admin): solo il
        // primo deve scrivere audit e spedire le mail. La guardia sullo stato elegge il
        // vincitore; il perdente rientra nel percorso idempotente "gia' annullata" qui sotto.
        const guard = await tx.booking.updateMany({
          where: { id: booking.id, status: { not: "CANCELED" } },
          data: { status: "CANCELED", cancelReason: normalizeCancelReason(input.cancelReason) },
        });

        if (guard.count === 0) {
          return null;
        }

        const saved = await tx.booking.findUniqueOrThrow({ where: { id: booking.id } });
        const guestSigners = await activeGuestSignersForBooking(booking, tx);

        await audit(tx, actor, {
          action: "BOOKING_CANCELED",
          entityType: "Booking",
          entityId: booking.id,
          before: booking,
          after: saved,
        });

        return { canceled: saved, guestSignersToNotify: guestSigners };
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  if (!result) {
    // Qualcun altro ha annullato un attimo prima: stessa risposta del percorso "gia' CANCELED",
    // senza audit doppio e senza mail doppie.
    const current = await prisma.booking.findUnique({ where: { id: booking.id } });
    if (current && shouldRetryOutlookDelete(current)) {
      runAfterResponse(() => markOutlookDeleted(current));
    }

    const refreshed = await getBookingWithWaivers(booking.id);
    return serializeManagedBooking(refreshed ?? booking, access.manageToken ?? undefined, access.baseUrl);
  }

  const { canceled, guestSignersToNotify } = result;

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

const adminAuditPageSize = 40;

// Estrae la causale dall'after dell'audit di cancellazione: il sanitizzatore la lascia passare
// (non e' un campo nascosto), quindi vive gia' nel JSON registrato. Difensivo su forma e tipo.
function auditCancelReason(after: unknown): string | null {
  if (!after || typeof after !== "object") return null;
  const value = (after as { cancelReason?: unknown }).cancelReason;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function getAdminAudit(
  input: { action?: AuditAction; cursor?: string; limit?: number } = {},
): Promise<AuditPage> {
  if (!appConfig.databaseConfigured) {
    return demoGetAdminAudit(input);
  }

  const limit = Math.min(Math.max(input.limit ?? adminAuditPageSize, 10), 100);
  const cursor = parseAdminAuditCursor(input.cursor);

  const items = await prisma.auditLog.findMany({
    where: {
      ...(input.action ? { action: input.action } : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const visible = items.slice(0, limit);
  const last = visible.at(-1);

  return {
    items: visible.map((item) => ({
      id: item.id,
      actorEmail: item.actorEmail,
      action: item.action,
      entityType: item.entityType,
      entityId: item.entityId,
      createdAt: item.createdAt.toISOString(),
      cancelReason: auditCancelReason(item.after),
    })),
    nextCursor: items.length > limit && last ? adminAuditCursor(last) : null,
  };
}

function adminAuditCursor(item: { createdAt: Date; id: string }) {
  return Buffer.from(`${item.createdAt.toISOString()}|${item.id}`, "utf8").toString("base64url");
}

function parseAdminAuditCursor(value: string | undefined) {
  if (!value) return null;

  try {
    const [createdAtRaw, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
    const createdAt = new Date(createdAtRaw);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// Statistiche aggregate read-only. Solo numeri, nessun nome: ogni query conta righe e le raggruppa.
// La demo twin (demoGetAdminStats) ricostruisce la stessa forma sui dati in memoria.
export async function getAdminStats(now: Date = new Date()): Promise<AdminStats> {
  if (!appConfig.databaseConfigured) {
    return demoGetAdminStats(now);
  }

  const weekWindowStart = statsWeekWindowStart(now);

  const [statusGroups, cancellations, recentStarts, allStarts] = await Promise.all([
    prisma.booking.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.booking.findMany({
      where: { status: "CANCELED" },
      select: { autoCanceledAt: true, cancelReason: true },
    }),
    prisma.booking.findMany({
      where: { start: { gte: weekWindowStart } },
      select: { start: true },
    }),
    prisma.booking.findMany({ select: { start: true } }),
  ]);

  const byStatus = summarizeStatuses(statusGroups.map((group) => ({ status: group.status, count: group._count._all })));
  const totalBookings = byStatus.reduce((sum, entry) => sum + entry.count, 0);

  return {
    totalBookings,
    perWeek: summarizeWeeks(recentStarts.map((booking) => booking.start), now),
    perStartHour: summarizeStartHours(allStarts.map((booking) => booking.start)),
    byStatus,
    cancellations: summarizeCancellations(cancellations),
  };
}

export function hasRangeConflict(
  start: Date,
  end: Date,
  ranges: Array<{ start: Date; end: Date }>,
) {
  return ranges.some((range) => rangesOverlap(start, end, range.start, range.end));
}
