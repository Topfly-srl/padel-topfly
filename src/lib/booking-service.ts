import type { Prisma } from "@prisma/client";
import { BookingStatus, Prisma as PrismaNamespace } from "@prisma/client";
import { AppError } from "@/lib/errors";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";
import { createOutlookEvent, deleteOutlookEvent, updateOutlookEvent } from "@/lib/graph";
import {
  demoCancelBooking,
  demoCreateAdminBlock,
  demoCreateBooking,
  demoDeleteAdminBlock,
  demoGetAdminAudit,
  demoGetAvailability,
  demoListBookings,
  demoUpdateBooking,
} from "@/lib/demo-store";
import { appConfig } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { assertDateParam, zonedDayBounds } from "@/lib/time";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";

type BookingWithOrganizer = Prisma.BookingGetPayload<{
  include: { organizer: { select: { email: true; name: true } } };
}>;

function serializeBooking(
  booking: BookingWithOrganizer,
  currentUser: CurrentUser,
): AvailabilityBooking {
  return {
    id: booking.id,
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    status: booking.status,
    organizerName: booking.organizer.name ?? booking.organizer.email,
    organizerEmail: booking.organizer.email,
    isMine: booking.organizerId === currentUser.id,
    outlookSyncStatus: booking.outlookSyncStatus,
  };
}

function serializeMyBooking(
  booking: BookingWithOrganizer,
  currentUser: CurrentUser,
): MyBooking {
  return {
    ...serializeBooking(booking, currentUser),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
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

function auditJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function audit(
  tx: Prisma.TransactionClient,
  actor: CurrentUser,
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
      actorId: actor.id,
      actorEmail: actor.email,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: input.before === undefined ? undefined : auditJson(input.before),
      after: input.after === undefined ? undefined : auditJson(input.after),
    },
  });
}

async function syncBooking(booking: BookingWithOrganizer, mode: "create" | "update") {
  const result =
    mode === "create"
      ? await createOutlookEvent(booking, booking.organizer)
      : await updateOutlookEvent(booking, booking.organizer);

  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      outlookEventId: result.eventId ?? booking.outlookEventId,
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
    include: { organizer: { select: { email: true, name: true } } },
  });
}

async function markOutlookDeleted(booking: BookingWithOrganizer) {
  const result = await deleteOutlookEvent(booking);

  return prisma.booking.update({
    where: { id: booking.id },
    data: {
      outlookSyncStatus: result.status,
      outlookSyncError: result.error ?? null,
    },
    include: { organizer: { select: { email: true, name: true } } },
  });
}

async function validateNoConflicts(
  tx: Prisma.TransactionClient,
  input: {
    start: Date;
    end: Date;
    organizerId: string;
    ignoreBookingId?: string;
  },
) {
  const [futureBookingCount, overlappingBookings, overlappingBlocks] =
    await Promise.all([
      tx.booking.count({
        where: {
          organizerId: input.organizerId,
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

export async function getAvailability(dateValue: string | null, currentUser: CurrentUser) {
  if (!appConfig.databaseConfigured) {
    return demoGetAvailability(dateValue, currentUser);
  }

  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);
  const now = new Date();

  const [bookings, blocks, myBookings] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: "CONFIRMED",
        start: { lt: bounds.end },
        end: { gt: bounds.start },
      },
      include: { organizer: { select: { email: true, name: true } } },
      orderBy: { start: "asc" },
    }),
    prisma.adminBlock.findMany({
      where: {
        start: { lt: bounds.end },
        end: { gt: bounds.start },
      },
      orderBy: { start: "asc" },
    }),
    prisma.booking.findMany({
      where: {
        organizerId: currentUser.id,
        OR: [{ end: { gte: now } }, { status: "CANCELED" }],
      },
      include: { organizer: { select: { email: true, name: true } } },
      orderBy: [{ status: "asc" }, { start: "asc" }],
      take: 12,
    }),
  ]);

  return {
    date,
    user: currentUser,
    settings: bookingPolicy,
    bookings: bookings.map((booking) => serializeBooking(booking, currentUser)),
    blocks: blocks.map(serializeBlock),
    myBookings: myBookings.map((booking) => serializeMyBooking(booking, currentUser)),
  };
}

export async function listBookings(currentUser: CurrentUser) {
  if (!appConfig.databaseConfigured) {
    return demoListBookings(currentUser);
  }

  const where =
    currentUser.role === "ADMIN"
      ? {}
      : {
          organizerId: currentUser.id,
        };

  const bookings = await prisma.booking.findMany({
    where,
    include: { organizer: { select: { email: true, name: true } } },
    orderBy: { start: "desc" },
    take: 100,
  });

  return bookings.map((booking) => serializeMyBooking(booking, currentUser));
}

export async function createBooking(
  currentUser: CurrentUser,
  input: { start: Date; end: Date },
) {
  if (!appConfig.databaseConfigured) {
    return demoCreateBooking(currentUser, input);
  }

  const booking = await prisma.$transaction(
    async (tx) => {
      await validateNoConflicts(tx, {
        start: input.start,
        end: input.end,
        organizerId: currentUser.id,
      });

      const created = await tx.booking.create({
        data: {
          start: input.start,
          end: input.end,
          organizerId: currentUser.id,
          outlookSyncStatus: "PENDING",
        },
        include: { organizer: { select: { email: true, name: true } } },
      });

      await audit(tx, currentUser, {
        action: "BOOKING_CREATED",
        entityType: "Booking",
        entityId: created.id,
        after: created,
      });

      return created;
    },
    { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
  );

  const synced = await syncBooking(booking, "create");
  return serializeMyBooking(synced, currentUser);
}

export async function updateBooking(
  currentUser: CurrentUser,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: BookingStatus },
) {
  if (!appConfig.databaseConfigured) {
    return demoUpdateBooking(currentUser, bookingId, input);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { organizer: { select: { email: true, name: true } } },
  });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const canEdit = currentUser.role === "ADMIN" || booking.organizerId === currentUser.id;
  if (!canEdit) {
    throw new AppError("Puoi modificare solo le tue prenotazioni.", 403);
  }

  const nextStatus = input.status ?? booking.status;
  if (input.status && currentUser.role !== "ADMIN") {
    throw new AppError("Solo gli admin possono cambiare lo stato manualmente.", 403);
  }

  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;

  const updated = await prisma.$transaction(
    async (tx) => {
      if (nextStatus === "CONFIRMED") {
        await validateNoConflicts(tx, {
          start: nextStart,
          end: nextEnd,
          organizerId: booking.organizerId,
          ignoreBookingId: booking.id,
        });
      }

      const saved = await tx.booking.update({
        where: { id: booking.id },
        data: {
          start: nextStart,
          end: nextEnd,
          status: nextStatus,
          outlookSyncStatus: nextStatus === "CONFIRMED" ? "PENDING" : booking.outlookSyncStatus,
        },
        include: { organizer: { select: { email: true, name: true } } },
      });

      await audit(tx, currentUser, {
        action: nextStatus === "CONFIRMED" ? "BOOKING_UPDATED" : "BOOKING_STATUS_CHANGED",
        entityType: "Booking",
        entityId: booking.id,
        before: booking,
        after: saved,
      });

      return saved;
    },
    { isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable },
  );

  const synced =
    updated.status === "CONFIRMED"
      ? await syncBooking(updated, "update")
      : await markOutlookDeleted(updated);

  return serializeMyBooking(synced, currentUser);
}

export async function cancelBooking(currentUser: CurrentUser, bookingId: string) {
  if (!appConfig.databaseConfigured) {
    return demoCancelBooking(currentUser, bookingId);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { organizer: { select: { email: true, name: true } } },
  });

  if (!booking) {
    throw new AppError("Prenotazione non trovata.", 404);
  }

  const canCancel = currentUser.role === "ADMIN" || booking.organizerId === currentUser.id;
  if (!canCancel) {
    throw new AppError("Puoi cancellare solo le tue prenotazioni.", 403);
  }

  if (booking.status === "CANCELED") {
    return serializeMyBooking(booking, currentUser);
  }

  const canceled = await prisma.$transaction(async (tx) => {
    const saved = await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CANCELED" },
      include: { organizer: { select: { email: true, name: true } } },
    });

    await audit(tx, currentUser, {
      action: "BOOKING_CANCELED",
      entityType: "Booking",
      entityId: booking.id,
      before: booking,
      after: saved,
    });

    return saved;
  });

  const synced = await markOutlookDeleted(canceled);
  return serializeMyBooking(synced, currentUser);
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

  const block = await prisma.$transaction(async (tx) => {
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
  });

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
