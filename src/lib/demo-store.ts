import { bookingPolicy, rangesOverlap, validateBookingPolicy } from "@/lib/booking-policy";
import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import {
  createManageToken,
  hashManageToken,
  isManageTokenValid,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import { assertDateParam, zonedDayBounds } from "@/lib/time";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";

type DemoBooking = {
  id: string;
  start: Date;
  end: Date;
  status: "CONFIRMED" | "CANCELED";
  organizerEmail: string;
  organizerName: string;
  manageTokenHash: string | null;
  manageTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type DemoBlock = {
  id: string;
  start: Date;
  end: Date;
  reason: string;
};

type DemoAccess = {
  adminUser?: CurrentUser | null;
  manageToken?: string | null;
  baseUrl?: string;
};

type DemoCreateInput = {
  start: Date;
  end: Date;
  organizerName: string;
  organizerEmail: string;
  baseUrl?: string;
};

const bookings: DemoBooking[] = [];
const blocks: DemoBlock[] = [];
const audit: AuditItem[] = [];

function id(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildManageUrl(baseUrl: string | undefined, bookingId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  return `${baseUrl.replace(/\/$/, "")}/manage/${bookingId}?token=${encodeURIComponent(token)}`;
}

function addAudit(actorEmail: string, action: string, entityType: string, entityId?: string) {
  audit.unshift({
    id: id("audit"),
    actorEmail,
    action,
    entityType,
    entityId: entityId ?? null,
    createdAt: new Date().toISOString(),
  });
}

function bookingToApi(booking: DemoBooking): AvailabilityBooking {
  return {
    id: booking.id,
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    status: booking.status,
    organizerName: booking.organizerName,
    outlookSyncStatus: "SKIPPED",
  };
}

function managedBookingToApi(
  booking: DemoBooking,
  manageToken?: string,
  baseUrl?: string,
): MyBooking {
  return {
    ...bookingToApi(booking),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    manageToken,
    manageUrl: buildManageUrl(baseUrl, booking.id, manageToken),
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

function normalizePublicInput(input: DemoCreateInput) {
  const organizerName = normalizePersonName(input.organizerName);
  const organizerEmail = normalizeEmail(input.organizerEmail);
  const errors: string[] = [];

  if (organizerName.split(" ").filter(Boolean).length < 2) {
    errors.push("Inserisci nome e cognome.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(organizerEmail)) {
    errors.push("Inserisci un'email valida.");
  }

  if (errors.length > 0) {
    throw new AppError(errors.join(" "), 422);
  }

  return { organizerName, organizerEmail };
}

function assertDemoBookingAllowed(
  organizerEmail: string,
  start: Date,
  end: Date,
  ignoreBookingId?: string,
) {
  const futureBookingCount = bookings.filter(
    (booking) =>
      booking.organizerEmail === organizerEmail &&
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

function assertDemoAccess(booking: DemoBooking, access: DemoAccess) {
  if (access.adminUser?.role === "ADMIN") {
    return access.adminUser.email;
  }

  if (isManageTokenValid(booking, access.manageToken)) {
    return booking.organizerEmail;
  }

  throw new AppError("Link di gestione non valido o scaduto.", 403);
}

export async function demoGetAvailability(dateValue: string | null) {
  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);

  return {
    date,
    settings: {
      ...bookingPolicy,
      allowedDomain: appConfig.allowedDomain,
    },
    bookings: bookings
      .filter(
        (booking) =>
          booking.status === "CONFIRMED" &&
          rangesOverlap(bounds.start, bounds.end, booking.start, booking.end),
      )
      .map(bookingToApi),
    blocks: blocks
      .filter((block) => rangesOverlap(bounds.start, bounds.end, block.start, block.end))
      .map(blockToApi),
  };
}

export async function demoLookupBookings(tokens: string[], baseUrl?: string) {
  const cleanTokens = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))].slice(0, 30);
  const tokenByHash = new Map(cleanTokens.map((token) => [hashManageToken(token), token]));
  const now = new Date();

  return bookings
    .filter(
      (booking) =>
        booking.manageTokenHash &&
        tokenByHash.has(booking.manageTokenHash) &&
        isManageTokenValid(booking, tokenByHash.get(booking.manageTokenHash), now) &&
        (booking.end >= now || booking.status === "CANCELED"),
    )
    .sort((left, right) => left.start.getTime() - right.start.getTime())
    .map((booking) =>
      managedBookingToApi(
        booking,
        booking.manageTokenHash ? tokenByHash.get(booking.manageTokenHash) : undefined,
        baseUrl,
      ),
    );
}

export async function demoListBookings(user: CurrentUser) {
  if (user.role !== "ADMIN") {
    throw new AppError("Serve un account admin.", 403);
  }

  return bookings.map((booking) => managedBookingToApi(booking));
}

export async function demoCreateBooking(input: DemoCreateInput) {
  const identity = normalizePublicInput(input);
  assertDemoBookingAllowed(identity.organizerEmail, input.start, input.end);

  const now = new Date();
  const manageToken = createManageToken();
  const booking: DemoBooking = {
    id: id("booking"),
    start: input.start,
    end: input.end,
    status: "CONFIRMED",
    organizerEmail: identity.organizerEmail,
    organizerName: identity.organizerName,
    manageTokenHash: hashManageToken(manageToken),
    manageTokenExpiresAt: manageTokenExpiresAt(input.end),
    createdAt: now,
    updatedAt: now,
  };

  bookings.push(booking);
  addAudit(identity.organizerEmail, "BOOKING_CREATED", "Booking", booking.id);
  return managedBookingToApi(booking, manageToken, input.baseUrl);
}

export async function demoUpdateBooking(
  access: DemoAccess,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: "CONFIRMED" | "CANCELED" },
) {
  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  const isAdmin = access.adminUser?.role === "ADMIN";

  if (input.status && !isAdmin) {
    throw new AppError("Usa il comando cancella per annullare la prenotazione.", 403);
  }

  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;
  const nextStatus = input.status ?? booking.status;

  if (nextStatus === "CONFIRMED") {
    assertDemoBookingAllowed(booking.organizerEmail, nextStart, nextEnd, booking.id);
  }

  booking.start = nextStart;
  booking.end = nextEnd;
  booking.status = nextStatus;
  booking.manageTokenExpiresAt = manageTokenExpiresAt(nextEnd);
  booking.updatedAt = new Date();
  addAudit(actorEmail, "BOOKING_UPDATED", "Booking", booking.id);

  return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl);
}

export async function demoCancelBooking(access: DemoAccess, bookingId: string) {
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  booking.status = "CANCELED";
  booking.updatedAt = new Date();
  addAudit(actorEmail, "BOOKING_CANCELED", "Booking", booking.id);

  return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl);
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
  addAudit(user.email, "ADMIN_BLOCK_CREATED", "AdminBlock", block.id);
  return blockToApi(block);
}

export async function demoDeleteAdminBlock(user: CurrentUser, blockId: string) {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) throw new AppError("Blocco non trovato.", 404);

  const [block] = blocks.splice(index, 1);
  addAudit(user.email, "ADMIN_BLOCK_DELETED", "AdminBlock", block.id);
  return { id: block.id };
}

export async function demoGetAdminAudit() {
  return audit.slice(0, 40);
}

export function demoReset() {
  bookings.splice(0);
  blocks.splice(0);
  audit.splice(0);
}
