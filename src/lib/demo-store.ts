import type { WaiverEmailStatus } from "@prisma/client";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";
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
import type { WaiverEvidence, WaiverInput } from "@/lib/waiver-service";

type DemoBooking = {
  id: string;
  start: Date;
  end: Date;
  status: "CONFIRMED" | "CANCELED";
  organizerEmail: string;
  organizerName: string;
  manageTokenHash: string | null;
  manageTokenExpiresAt: Date | null;
  playerCount: number;
  waiverRevision: number;
  guestWaiverTokenHash: string | null;
  guestWaiverTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type DemoWaiverSignature = {
  id: string;
  bookingId: string;
  bookingRevision: number;
  status: "ACTIVE" | "CANCELED";
  signerName: string;
  signerEmail: string;
  emailStatus: WaiverEmailStatus;
  cancelTokenHash: string | null;
  cancelTokenExpiresAt: Date | null;
  canceledAt: Date | null;
  signedAt: Date;
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
  playerCount?: number;
  waiver?: WaiverInput;
  waiverEvidence?: WaiverEvidence;
  baseUrl?: string;
};

const bookings: DemoBooking[] = [];
const blocks: DemoBlock[] = [];
const audit: AuditItem[] = [];
const waiverSignatures: DemoWaiverSignature[] = [];

function id(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildManageUrl(baseUrl: string | undefined, bookingId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  return `${baseUrl.replace(/\/$/, "")}/manage/${bookingId}?${params.toString()}`;
}

function buildGuestWaiverUrl(baseUrl: string | undefined, bookingId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  return `${baseUrl.replace(/\/$/, "")}/waiver/${bookingId}?${params.toString()}`;
}

function demoWaiverSummary(booking: DemoBooking) {
  const current = waiverSignatures.filter(
    (signature) =>
      signature.bookingId === booking.id &&
      signature.bookingRevision === booking.waiverRevision &&
      signature.status === "ACTIVE",
  );
  const statuses = current.map((signature) => signature.emailStatus);
  const emailStatus: WaiverEmailStatus | null =
    statuses.length === 0
      ? null
      : statuses.includes("FAILED")
        ? "FAILED"
        : statuses.includes("PENDING")
          ? "PENDING"
          : statuses.includes("SKIPPED")
            ? "SKIPPED"
            : "SENT";

  return {
    signedCount: current.length,
    remainingCount: Math.max(0, booking.playerCount - current.length),
    emailStatus,
  };
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
  const waiverSummary = demoWaiverSummary(booking);

  return {
    id: booking.id,
    start: booking.start.toISOString(),
    end: booking.end.toISOString(),
    status: booking.status,
    organizerName: booking.organizerName,
    outlookSyncStatus: "SKIPPED",
    playerCount: booking.playerCount,
    waiverSignedCount: waiverSummary.signedCount,
    waiverEmailStatus: waiverSummary.emailStatus,
  };
}

function managedBookingToApi(
  booking: DemoBooking,
  manageToken?: string,
  baseUrl?: string,
  guestWaiverToken?: string,
): MyBooking {
  return {
    ...bookingToApi(booking),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    manageToken,
    manageUrl: buildManageUrl(baseUrl, booking.id, manageToken),
    guestWaiverToken,
    guestWaiverUrl: buildGuestWaiverUrl(baseUrl, booking.id, guestWaiverToken),
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
  const guestWaiverToken = createManageToken();
  const booking: DemoBooking = {
    id: id("booking"),
    start: input.start,
    end: input.end,
    status: "CONFIRMED",
    organizerEmail: identity.organizerEmail,
    organizerName: identity.organizerName,
    manageTokenHash: hashManageToken(manageToken),
    manageTokenExpiresAt: manageTokenExpiresAt(input.end),
    playerCount: input.playerCount ?? 4,
    waiverRevision: 1,
    guestWaiverTokenHash: hashManageToken(guestWaiverToken),
    guestWaiverTokenExpiresAt: manageTokenExpiresAt(input.end),
    createdAt: now,
    updatedAt: now,
  };

  bookings.push(booking);
  waiverSignatures.push({
    id: id("waiver"),
    bookingId: booking.id,
    bookingRevision: booking.waiverRevision,
    status: "ACTIVE",
    signerName: identity.organizerName,
    signerEmail: identity.organizerEmail,
    emailStatus: "SKIPPED",
    cancelTokenHash: null,
    cancelTokenExpiresAt: null,
    canceledAt: null,
    signedAt: now,
  });
  addAudit(identity.organizerEmail, "BOOKING_CREATED", "Booking", booking.id);
  addAudit(identity.organizerEmail, "WAIVER_SIGNED", "WaiverSignature", booking.id);
  return managedBookingToApi(booking, manageToken, input.baseUrl, guestWaiverToken);
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
  const requiresFreshWaivers =
    nextStatus === "CONFIRMED" &&
    (booking.status !== "CONFIRMED" ||
      nextStart.getTime() !== booking.start.getTime() ||
      nextEnd.getTime() !== booking.end.getTime());
  const guestWaiverToken = requiresFreshWaivers ? createManageToken() : undefined;

  if (nextStatus === "CONFIRMED") {
    assertDemoBookingAllowed(booking.organizerEmail, nextStart, nextEnd, booking.id);
  }

  booking.start = nextStart;
  booking.end = nextEnd;
  booking.status = nextStatus;
  booking.manageTokenExpiresAt = manageTokenExpiresAt(nextEnd);
  if (guestWaiverToken) {
    booking.waiverRevision += 1;
    booking.guestWaiverTokenHash = hashManageToken(guestWaiverToken);
    booking.guestWaiverTokenExpiresAt = manageTokenExpiresAt(nextEnd);
  }
  booking.updatedAt = new Date();
  addAudit(
    actorEmail,
    nextStatus === "CONFIRMED" ? "BOOKING_UPDATED" : "BOOKING_STATUS_CHANGED",
    "Booking",
    booking.id,
  );

  return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl, guestWaiverToken);
}

export async function demoCancelBooking(access: DemoAccess, bookingId: string) {
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  if (booking.status === "CANCELED") {
    return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl);
  }

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
  if (!isAlignedToSlot(input.start) || !isAlignedToSlot(input.end)) {
    throw new AppError("Il blocco deve usare step da 15 minuti.", 422);
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

function assertDemoGuestWaiverAccess(booking: DemoBooking, token: string | null | undefined) {
  const isValid = isManageTokenValid(
    {
      manageTokenHash: booking.guestWaiverTokenHash,
      manageTokenExpiresAt: booking.guestWaiverTokenExpiresAt,
    },
    token,
  );

  if (!isValid) {
    throw new AppError("Link firma ospiti non valido o scaduto.", 403);
  }

  if (booking.status !== "CONFIRMED") {
    throw new AppError("La prenotazione non e' piu' attiva.", 409);
  }
}

export async function demoGetWaiverContext(bookingId: string, token: string | null) {
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  assertDemoGuestWaiverAccess(booking, token);
  const summary = demoWaiverSummary(booking);

  return {
    booking: {
      id: booking.id,
      start: booking.start.toISOString(),
      end: booking.end.toISOString(),
      organizerName: booking.organizerName,
      playerCount: booking.playerCount,
      waiverRevision: booking.waiverRevision,
      waiverSignedCount: summary.signedCount,
      remainingSignatures: summary.remainingCount,
      documentVersion: appConfig.waiver.documentVersion,
      regulationUrl: "/legal/regolamento-padel-topfly-v1.pdf",
    },
  };
}

export async function demoSignGuestWaiver(
  bookingId: string,
  token: string | null,
  input: WaiverInput,
  _evidence: WaiverEvidence,
) {
  void _evidence;

  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  assertDemoGuestWaiverAccess(booking, token);
  const summary = demoWaiverSummary(booking);
  if (summary.signedCount >= booking.playerCount) {
    throw new AppError("Tutte le firme per questa prenotazione risultano gia' raccolte.", 409);
  }

  const signerName = normalizePersonName(input.signerName);
  const signerEmail = normalizeEmail(input.signerEmail);
  if (
    waiverSignatures.some(
      (signature) =>
        signature.bookingId === booking.id &&
        signature.bookingRevision === booking.waiverRevision &&
        signature.signerEmail === signerEmail &&
        signature.status === "ACTIVE",
    )
  ) {
    throw new AppError("Questa email ha gia' firmato lo scarico per questa prenotazione.", 409);
  }

  const cancelToken = createManageToken();
  waiverSignatures.push({
    id: id("waiver"),
    bookingId: booking.id,
    bookingRevision: booking.waiverRevision,
    status: "ACTIVE",
    signerName,
    signerEmail,
    emailStatus: "SKIPPED",
    cancelTokenHash: hashManageToken(cancelToken),
    cancelTokenExpiresAt: manageTokenExpiresAt(booking.end),
    canceledAt: null,
    signedAt: new Date(),
  });
  addAudit(signerEmail, "WAIVER_SIGNED", "WaiverSignature", booking.id);

  return demoGetWaiverContext(bookingId, token);
}

function assertDemoGuestCancelAccess(signature: DemoWaiverSignature, token: string | null | undefined) {
  if (
    !isManageTokenValid(
      {
        manageTokenHash: signature.cancelTokenHash,
        manageTokenExpiresAt: signature.cancelTokenExpiresAt,
      },
      token,
    )
  ) {
    throw new AppError("Link rinuncia posto non valido o scaduto.", 403);
  }
}

function demoCancelContext(signature: DemoWaiverSignature) {
  const booking = bookings.find((item) => item.id === signature.bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);
  const summary = demoWaiverSummary(booking);

  return {
    signature: {
      id: signature.id,
      signerName: signature.signerName,
      signerEmail: signature.signerEmail,
      status: signature.status,
      canceledAt: signature.canceledAt?.toISOString() ?? null,
    },
    booking: {
      id: booking.id,
      start: booking.start.toISOString(),
      end: booking.end.toISOString(),
      organizerName: booking.organizerName,
      playerCount: booking.playerCount,
      waiverSignedCount: summary.signedCount,
      remainingSignatures: summary.remainingCount,
      status: booking.status,
    },
  };
}

export async function demoGetGuestWaiverCancelContext(signatureId: string, token: string | null) {
  const signature = waiverSignatures.find((item) => item.id === signatureId);
  if (!signature) throw new AppError("Firma waiver non trovata.", 404);

  assertDemoGuestCancelAccess(signature, token);
  return demoCancelContext(signature);
}

export async function demoCancelGuestWaiverSignature(signatureId: string, token: string | null) {
  const signature = waiverSignatures.find((item) => item.id === signatureId);
  if (!signature) throw new AppError("Firma waiver non trovata.", 404);

  assertDemoGuestCancelAccess(signature, token);
  const booking = bookings.find((item) => item.id === signature.bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);
  if (booking.status !== "CONFIRMED") {
    throw new AppError("La prenotazione non e' piu' attiva.", 409);
  }

  if (signature.status !== "CANCELED") {
    signature.status = "CANCELED";
    signature.canceledAt = new Date();
    addAudit(signature.signerEmail, "WAIVER_SIGNATURE_CANCELED", "WaiverSignature", signature.id);
  }

  return demoCancelContext(signature);
}

export function demoReset() {
  bookings.splice(0);
  blocks.splice(0);
  audit.splice(0);
  waiverSignatures.splice(0);
}
