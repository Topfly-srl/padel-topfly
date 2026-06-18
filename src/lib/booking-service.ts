import type { Booking, Prisma, WaiverEmailStatus } from "@prisma/client";
import { BookingStatus, Prisma as PrismaNamespace } from "@prisma/client";
import { AppError } from "@/lib/errors";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";
import { appConfig, isAllowedCompanyEmail } from "@/lib/config";
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
import { createOutlookEvent, deleteOutlookEvent, updateOutlookEvent } from "@/lib/graph";
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
  sendWaiverSignatureEmail,
  summarizeWaiverSignatures,
  validatePlayerCount,
  type WaiverEvidence,
  type WaiverInput,
} from "@/lib/waiver-service";
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
  if (appConfig.isPreview) params.set("test", "1");
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

const hiddenAuditFields = new Set([
  "manageTokenHash",
  "manageTokenExpiresAt",
  "guestWaiverTokenHash",
  "guestWaiverTokenExpiresAt",
  "outlookEventId",
  "outlookSyncError",
]);

export function sanitizeAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !hiddenAuditFields.has(key))
        .map(([key, nestedValue]) => [key, sanitizeAuditValue(nestedValue)]),
    );
  }

  return value;
}

function auditJson(value: unknown) {
  const serializableValue = JSON.parse(JSON.stringify(value));
  return sanitizeAuditValue(serializableValue) as Prisma.InputJsonValue;
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

async function syncBooking(
  booking: Booking,
  mode: "create" | "update",
  manageToken?: string,
  baseUrl?: string,
  guestWaiverToken?: string,
) {
  const manageUrl = buildManageUrl(baseUrl, booking.id, manageToken);
  const guestWaiverUrl = buildGuestWaiverUrl(baseUrl, booking.id, guestWaiverToken);
  const result =
    mode === "create"
      ? await createOutlookEvent(booking, bookingOrganizer(booking), manageUrl, guestWaiverUrl)
      : await updateOutlookEvent(booking, bookingOrganizer(booking), manageUrl, guestWaiverUrl);

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
    errors.push("L'email e' troppo lunga.");
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
  const [futureBookingCount, overlappingBookings, overlappingBlocks] = await Promise.all([
    tx.booking.count({
      where: {
        organizerEmail: input.organizerEmail,
        status: "CONFIRMED",
        end: { gte: new Date() },
        id: input.ignoreBookingId ? { not: input.ignoreBookingId } : undefined,
      },
    }),
    tx.booking.findMany({
      where: {
        status: "CONFIRMED",
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
    errors.push("Il campo e' gia' prenotato in quella fascia.");
  }

  if (overlappingBlocks.length > 0) {
    errors.push("Il campo e' bloccato dall'admin in quella fascia.");
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

export async function getAvailability(dateValue: string | null) {
  if (!appConfig.databaseConfigured) {
    return demoGetAvailability(dateValue);
  }

  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: "CONFIRMED",
        start: { lt: bounds.end },
        end: { gt: bounds.start },
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
    bookings: bookings.map(serializeBooking),
    blocks: blocks.map(serializeBlock),
  };
}

export async function lookupBookings(tokens: string[], baseUrl?: string) {
  if (!appConfig.databaseConfigured) {
    return demoLookupBookings(tokens, baseUrl);
  }

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

  const identity = normalizePublicBookingInput(input);
  const manageToken = createManageToken();
  const manageTokenHash = hashManageToken(manageToken);
  const tokenExpiresAt = manageTokenExpiresAt(input.end);
  const guestWaiverToken = createGuestWaiverToken();
  const guestWaiverData = guestWaiverTokenData(guestWaiverToken, input.end);

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
            organizerName: identity.organizerName,
            organizerEmail: identity.organizerEmail,
            playerCount: identity.playerCount,
            manageTokenHash,
            manageTokenExpiresAt: tokenExpiresAt,
            ...guestWaiverData,
            outlookSyncStatus: "PENDING",
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

        return { booking: created, organizerWaiverId: organizerWaiver.id };
      },
      { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
    ),
  );

  await sendWaiverSignatureEmail(result.organizerWaiverId);

  const synced = await syncBooking(result.booking, "create", manageToken, input.baseUrl, guestWaiverToken);
  const refreshed = await getBookingWithWaivers(synced.id);
  return serializeManagedBooking(refreshed ?? synced, manageToken, input.baseUrl, guestWaiverToken);
}

export async function updateBooking(
  access: BookingAccess,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: BookingStatus },
) {
  if (!appConfig.databaseConfigured) {
    return demoUpdateBooking(access, bookingId, input);
  }

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const actor = assertBookingAccess(booking, access);
  const isAdmin = access.adminUser?.role === "ADMIN";

  if (input.status && !isAdmin) {
    throw new AppError("Usa il comando cancella per annullare la prenotazione.", 403);
  }

  const nextStatus = input.status ?? booking.status;
  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;
  const requiresFreshWaivers =
    nextStatus === "CONFIRMED" &&
    (booking.status !== "CONFIRMED" ||
      nextStart.getTime() !== booking.start.getTime() ||
      nextEnd.getTime() !== booking.end.getTime());
  const nextGuestWaiverToken = requiresFreshWaivers ? createGuestWaiverToken() : undefined;

  const updated = await retryPrismaTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        if (nextStatus === "CONFIRMED") {
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
            manageTokenExpiresAt: manageTokenExpiresAt(nextEnd),
            ...(nextGuestWaiverToken
              ? {
                  waiverRevision: { increment: 1 },
                  ...guestWaiverTokenData(nextGuestWaiverToken, nextEnd),
                }
              : {}),
            outlookSyncStatus: nextStatus === "CONFIRMED" ? "PENDING" : booking.outlookSyncStatus,
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

  const synced =
    updated.status === "CONFIRMED"
      ? await syncBooking(
          updated,
          "update",
          access.manageToken ?? undefined,
          access.baseUrl,
          nextGuestWaiverToken,
        )
      : await markOutlookDeleted(updated);

  const refreshed = await getBookingWithWaivers(synced.id);
  return serializeManagedBooking(
    refreshed ?? synced,
    access.manageToken ?? undefined,
    access.baseUrl,
    nextGuestWaiverToken,
  );
}

export async function cancelBooking(access: BookingAccess, bookingId: string) {
  if (!appConfig.databaseConfigured) {
    return demoCancelBooking(access, bookingId);
  }

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const actor = assertBookingAccess(booking, access);

  if (booking.status === "CANCELED") {
    const synced = shouldRetryOutlookDelete(booking)
      ? await markOutlookDeleted(booking)
      : booking;

    const refreshed = await getBookingWithWaivers(synced.id);
    return serializeManagedBooking(refreshed ?? synced, access.manageToken ?? undefined, access.baseUrl);
  }

  const canceled = await prisma.$transaction(async (tx) => {
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
  });

  const synced = await markOutlookDeleted(canceled);
  const refreshed = await getBookingWithWaivers(synced.id);
  return serializeManagedBooking(refreshed ?? synced, access.manageToken ?? undefined, access.baseUrl);
}

export async function createAdminBlock(
  currentUser: CurrentUser,
  input: { start: Date; end: Date; reason: string },
) {
  if (!appConfig.databaseConfigured) {
    return demoCreateAdminBlock(currentUser, input);
  }

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
        const overlappingBookings = await tx.booking.findMany({
          where: {
            status: "CONFIRMED",
            start: { lt: input.end },
            end: { gt: input.start },
          },
          select: { id: true },
        });

        if (overlappingBookings.length > 0) {
          throw new AppError(
            "Ci sono prenotazioni confermate in questa fascia. Cancellale o spostale prima.",
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

export function isExternalEmail(email: string) {
  return email.trim().includes("@") && !isAllowedCompanyEmail(normalizeEmail(email));
}
