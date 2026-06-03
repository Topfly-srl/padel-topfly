import { bookingPolicy, rangesOverlap, validateBookingPolicy } from "@/lib/booking-policy";
import { AppError } from "@/lib/errors";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";
import { assertDateParam, zonedDayBounds } from "@/lib/time";

type DemoBooking = {
  id: string;
  start: Date;
  end: Date;
  status: "CONFIRMED" | "CANCELED";
  organizerId: string;
  organizerEmail: string;
  organizerName: string;
  createdAt: Date;
  updatedAt: Date;
};

type DemoBlock = {
  id: string;
  start: Date;
  end: Date;
  reason: string;
};

const bookings: DemoBooking[] = [];
const blocks: DemoBlock[] = [];
const audit: AuditItem[] = [];

function id(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function addAudit(user: CurrentUser, action: string, entityType: string, entityId?: string) {
  audit.unshift({
    id: id("audit"),
    actorEmail: user.email,
    action,
    entityType,
    entityId: entityId ?? null,
    createdAt: new Date().toISOString(),
  });
}

function bookingToApi(booking: DemoBooking, user: CurrentUser): AvailabilityBooking {
  return {
    id: booking.id,
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    status: booking.status,
    organizerEmail: booking.organizerEmail,
    organizerName: booking.organizerName,
    isMine: booking.organizerId === user.id,
    outlookSyncStatus: "SKIPPED",
  };
}

function myBookingToApi(booking: DemoBooking, user: CurrentUser): MyBooking {
  return {
    ...bookingToApi(booking, user),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

function blockToApi(block: DemoBlock): AvailabilityBlock {
  return {
    id: block.id,
    start: block.start.toISOString(),
    end: block.end.toISOString(),
    reason: block.reason,
  };
}

function assertDemoBookingAllowed(
  user: CurrentUser,
  start: Date,
  end: Date,
  ignoreBookingId?: string,
) {
  const futureBookingCount = bookings.filter(
    (booking) =>
      booking.organizerId === user.id &&
      booking.status === "CONFIRMED" &&
      booking.end >= new Date() &&
      booking.id !== ignoreBookingId,
  ).length;

  const errors = validateBookingPolicy({
    start,
    end,
    futureBookingCount,
  });

  if (
    bookings.some(
      (booking) =>
        booking.status === "CONFIRMED" &&
        booking.id !== ignoreBookingId &&
        rangesOverlap(start, end, booking.start, booking.end),
    )
  ) {
    errors.push("Il campo e' gia' prenotato in quella fascia.");
  }

  if (blocks.some((block) => rangesOverlap(start, end, block.start, block.end))) {
    errors.push("Il campo e' bloccato dall'admin in quella fascia.");
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(" "), 422);
  }
}

export async function demoGetAvailability(dateValue: string | null, user: CurrentUser) {
  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);
  const now = new Date();

  return {
    date,
    user,
    settings: bookingPolicy,
    bookings: bookings
      .filter(
        (booking) =>
          booking.status === "CONFIRMED" &&
          rangesOverlap(bounds.start, bounds.end, booking.start, booking.end),
      )
      .map((booking) => bookingToApi(booking, user)),
    blocks: blocks
      .filter((block) => rangesOverlap(bounds.start, bounds.end, block.start, block.end))
      .map(blockToApi),
    myBookings: bookings
      .filter(
        (booking) =>
          booking.organizerId === user.id &&
          (booking.end >= now || booking.status === "CANCELED"),
      )
      .slice(0, 12)
      .map((booking) => myBookingToApi(booking, user)),
  };
}

export async function demoListBookings(user: CurrentUser) {
  return bookings
    .filter((booking) => user.role === "ADMIN" || booking.organizerId === user.id)
    .map((booking) => myBookingToApi(booking, user));
}

export async function demoCreateBooking(user: CurrentUser, input: { start: Date; end: Date }) {
  assertDemoBookingAllowed(user, input.start, input.end);

  const now = new Date();
  const booking: DemoBooking = {
    id: id("booking"),
    start: input.start,
    end: input.end,
    status: "CONFIRMED",
    organizerId: user.id,
    organizerEmail: user.email,
    organizerName: user.name ?? user.email,
    createdAt: now,
    updatedAt: now,
  };

  bookings.push(booking);
  addAudit(user, "BOOKING_CREATED", "Booking", booking.id);
  return myBookingToApi(booking, user);
}

export async function demoUpdateBooking(
  user: CurrentUser,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: "CONFIRMED" | "CANCELED" },
) {
  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) throw new AppError("Prenotazione non trovata.", 404);
  if (user.role !== "ADMIN" && booking.organizerId !== user.id) {
    throw new AppError("Puoi modificare solo le tue prenotazioni.", 403);
  }

  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;
  const nextStatus = input.status ?? booking.status;

  if (nextStatus === "CONFIRMED") {
    assertDemoBookingAllowed(
      {
        id: booking.organizerId,
        email: booking.organizerEmail,
        name: booking.organizerName,
        role: "USER",
      },
      nextStart,
      nextEnd,
      booking.id,
    );
  }

  booking.start = nextStart;
  booking.end = nextEnd;
  booking.status = nextStatus;
  booking.updatedAt = new Date();
  addAudit(user, "BOOKING_UPDATED", "Booking", booking.id);

  return myBookingToApi(booking, user);
}

export async function demoCancelBooking(user: CurrentUser, bookingId: string) {
  return demoUpdateBooking(user, bookingId, { status: "CANCELED" });
}

export async function demoCreateAdminBlock(
  user: CurrentUser,
  input: { start: Date; end: Date; reason: string },
) {
  if (input.start >= input.end) {
    throw new AppError("Il blocco deve avere un orario di fine valido.", 422);
  }
  if (!input.reason.trim()) throw new AppError("Inserisci un motivo per il blocco.", 422);
  if (
    bookings.some(
      (booking) =>
        booking.status === "CONFIRMED" &&
        rangesOverlap(input.start, input.end, booking.start, booking.end),
    )
  ) {
    throw new AppError("Ci sono prenotazioni confermate in questa fascia.", 422);
  }

  const block: DemoBlock = {
    id: id("block"),
    start: input.start,
    end: input.end,
    reason: input.reason.trim(),
  };

  blocks.push(block);
  addAudit(user, "ADMIN_BLOCK_CREATED", "AdminBlock", block.id);
  return blockToApi(block);
}

export async function demoDeleteAdminBlock(user: CurrentUser, blockId: string) {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) throw new AppError("Blocco non trovato.", 404);

  const [block] = blocks.splice(index, 1);
  addAudit(user, "ADMIN_BLOCK_DELETED", "AdminBlock", block.id);
  return { id: block.id };
}

export async function demoGetAdminAudit() {
  return audit.slice(0, 40);
}
