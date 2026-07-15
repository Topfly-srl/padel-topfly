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
import {
  signatureDeadlineAt,
  signatureReminderDueAt,
  signatureReplacementDeadlineAt,
} from "@/lib/signature-workflow";
import type {
  AuditItem,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";
import { computeGuestSeatCancelable } from "@/lib/waiver-service";
import type { WaiverEvidence, WaiverInput } from "@/lib/waiver-service";

type DemoBooking = {
  id: string;
  start: Date;
  end: Date;
  status: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
  organizerEmail: string;
  organizerName: string;
  manageTokenHash: string | null;
  manageTokenExpiresAt: Date | null;
  playerCount: number;
  waiverRevision: number;
  signatureDeadlineAt: Date | null;
  signatureWindowStartedAt: Date | null;
  signatureReminderSentAt: Date | null;
  signatureConfirmedAt: Date | null;
  autoCanceledAt: Date | null;
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

function validateDemoPlayerCount(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 4) {
    throw new AppError("Inserisci un numero giocatori tra 1 e 4.", 422);
  }

  return value;
}

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

function buildGuestWaiverCancelUrl(baseUrl: string | undefined, signatureId: string, token: string | undefined) {
  if (!baseUrl || !token) return undefined;
  const params = new URLSearchParams({ token });
  return `${baseUrl.replace(/\/$/, "")}/waiver/cancel/${signatureId}?${params.toString()}`;
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

function isDemoActiveBooking(booking: DemoBooking, now = new Date()) {
  return (
    booking.status === "CONFIRMED" ||
    (booking.status === "PENDING_SIGNATURES" &&
      (!booking.signatureDeadlineAt || booking.signatureDeadlineAt > now))
  );
}

function demoProcessDeadlines(now = new Date()) {
  let reminded = 0;
  let canceled = 0;
  for (const booking of bookings) {
    if (booking.status !== "PENDING_SIGNATURES") continue;
    const summary = demoWaiverSummary(booking);

    // Il cron di produzione non riconferma da solo: la conferma avviene solo alla firma
    // (markBookingConfirmedIfComplete). Una pending gia' completa resta com'e', ne' confermata
    // ne' annullata, esattamente come i cancelCandidates che escono con signedCount pieno.
    if (summary.signedCount >= booking.playerCount) continue;

    if (booking.signatureDeadlineAt && booking.signatureDeadlineAt <= now) {
      booking.status = "CANCELED";
      booking.autoCanceledAt = now;
      booking.updatedAt = now;
      addAudit("system", "BOOKING_AUTO_CANCELED_SIGNATURES", "Booking", booking.id);
      canceled += 1;
      continue;
    }

    const reminderDueAt = signatureReminderDueAt(booking);

    if (!booking.signatureReminderSentAt && reminderDueAt && reminderDueAt <= now) {
      booking.signatureReminderSentAt = now;
      booking.updatedAt = now;
      addAudit("system", "BOOKING_SIGNATURE_REMINDER_SENT", "Booking", booking.id);
      reminded += 1;
    }
  }

  // Riga di sintesi datata per ogni run con attivita', come in produzione: niente riga a vuoto.
  if (reminded + canceled > 0) {
    addAudit("system", "SIGNATURE_DEADLINES_RUN", "System");
  }
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
    signatureDeadlineAt: booking.signatureDeadlineAt?.toISOString() ?? null,
    signatureConfirmedAt: booking.signatureConfirmedAt?.toISOString() ?? null,
    autoCanceledAt: booking.autoCanceledAt?.toISOString() ?? null,
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
    errors.push("L'email è troppo lunga.");
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
  demoProcessDeadlines();
  const futureBookingCount = bookings.filter(
    (booking) =>
      booking.organizerEmail === organizerEmail &&
      isDemoActiveBooking(booking) &&
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
        isDemoActiveBooking(booking) &&
        booking.id !== ignoreBookingId &&
        rangesOverlap(start, end, booking.start, booking.end),
    )
  ) {
    errors.push("Il campo è già prenotato in quella fascia.");
  }

  if (blocks.some((block) => rangesOverlap(start, end, block.start, block.end))) {
    errors.push("Il campo è bloccato dall'admin in quella fascia.");
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
  demoProcessDeadlines();
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
          isDemoActiveBooking(booking) &&
          rangesOverlap(bounds.start, bounds.end, booking.start, booking.end),
      )
      .map(bookingToApi),
    blocks: blocks
      .filter((block) => rangesOverlap(bounds.start, bounds.end, block.start, block.end))
      .map(blockToApi),
  };
}

export async function demoLookupBookings(tokens: string[], baseUrl?: string) {
  demoProcessDeadlines();
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
  const playerCount = validateDemoPlayerCount(input.playerCount ?? 4);
  assertDemoBookingAllowed(identity.organizerEmail, input.start, input.end);

  const now = new Date();
  const manageToken = createManageToken();
  const guestWaiverToken = playerCount > 1 ? createManageToken() : undefined;
  const booking: DemoBooking = {
    id: id("booking"),
    start: input.start,
    end: input.end,
    status: "PENDING_SIGNATURES",
    organizerEmail: identity.organizerEmail,
    organizerName: identity.organizerName,
    manageTokenHash: hashManageToken(manageToken),
    manageTokenExpiresAt: manageTokenExpiresAt(input.end),
    playerCount,
    waiverRevision: 1,
    signatureDeadlineAt: signatureDeadlineAt(input.start, now),
    signatureWindowStartedAt: now,
    signatureReminderSentAt: null,
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    guestWaiverTokenHash: guestWaiverToken ? hashManageToken(guestWaiverToken) : null,
    guestWaiverTokenExpiresAt: guestWaiverToken ? manageTokenExpiresAt(input.end) : null,
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
  if (demoWaiverSummary(booking).signedCount >= booking.playerCount) {
    booking.status = "CONFIRMED";
    booking.signatureConfirmedAt = now;
    booking.updatedAt = now;
    addAudit(identity.organizerEmail, "BOOKING_SIGNATURES_COMPLETED", "Booking", booking.id);
  }
  return managedBookingToApi(booking, manageToken, input.baseUrl, guestWaiverToken);
}

export async function demoUpdateBooking(
  access: DemoAccess,
  bookingId: string,
  input: { start?: Date; end?: Date; status?: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED"; playerCount?: number },
) {
  demoProcessDeadlines();
  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  const isAdmin = access.adminUser?.role === "ADMIN";

  if (input.status && !isAdmin) {
    throw new AppError("Usa il comando cancella per annullare la prenotazione.", 403);
  }

  const nextStart = input.start ?? booking.start;
  const nextEnd = input.end ?? booking.end;
  const nextPlayerCount = input.playerCount === undefined
    ? booking.playerCount
    : validateDemoPlayerCount(input.playerCount);
  const timeChanged =
    nextStart.getTime() !== booking.start.getTime() ||
    nextEnd.getTime() !== booking.end.getTime();
  const playerCountChanged = nextPlayerCount !== booking.playerCount;
  const slotOrPlayerCountChanged = timeChanged || playerCountChanged;
  const canConfirmSinglePlayerWithCurrentSignature =
    !timeChanged &&
    nextPlayerCount === 1 &&
    demoWaiverSummary(booking).signedCount >= 1 &&
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
  const guestWaiverToken = requiresFreshWaivers ? createManageToken() : undefined;

  if (nextStatus === "CONFIRMED" || nextStatus === "PENDING_SIGNATURES") {
    assertDemoBookingAllowed(booking.organizerEmail, nextStart, nextEnd, booking.id);
  }

  booking.start = nextStart;
  booking.end = nextEnd;
  booking.status = nextStatus;
  booking.playerCount = nextPlayerCount;
  booking.manageTokenExpiresAt = manageTokenExpiresAt(nextEnd);
  if (guestWaiverToken) {
    booking.waiverRevision += 1;
    booking.guestWaiverTokenHash = hashManageToken(guestWaiverToken);
    booking.guestWaiverTokenExpiresAt = manageTokenExpiresAt(nextEnd);
    booking.signatureDeadlineAt = signatureDeadlineAt(nextStart);
    booking.signatureWindowStartedAt = new Date();
    booking.signatureReminderSentAt = null;
    booking.signatureConfirmedAt = null;
    booking.autoCanceledAt = null;
  } else if (canConfirmSinglePlayerWithCurrentSignature) {
    booking.signatureReminderSentAt = null;
    booking.signatureConfirmedAt = booking.signatureConfirmedAt ?? new Date();
    booking.autoCanceledAt = null;
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
  demoProcessDeadlines();
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
  demoProcessDeadlines();

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
        isDemoActiveBooking(booking) &&
        rangesOverlap(input.start, input.end, booking.start, booking.end),
    )
  ) {
    throw new AppError("Ci sono prenotazioni attive in questa fascia.", 422);
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

  if (booking.status !== "CONFIRMED" && booking.status !== "PENDING_SIGNATURES") {
    throw new AppError("La prenotazione non è più attiva.", 409);
  }
}

export async function demoGetWaiverContext(bookingId: string, token: string | null) {
  demoProcessDeadlines();
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
      status: booking.status,
      signatureDeadlineAt: booking.signatureDeadlineAt?.toISOString() ?? null,
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
  baseUrl?: string,
) {
  void _evidence;

  demoProcessDeadlines();
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  assertDemoGuestWaiverAccess(booking, token);
  if (
    booking.status === "PENDING_SIGNATURES" &&
    booking.signatureDeadlineAt &&
    booking.signatureDeadlineAt <= new Date()
  ) {
    throw new AppError(
      "La scadenza per le firme è passata: la prenotazione non è più confermabile.",
      409,
    );
  }
  const summary = demoWaiverSummary(booking);
  if (summary.signedCount >= booking.playerCount) {
    throw new AppError("Tutte le firme per questa prenotazione risultano già raccolte.", 409);
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
    throw new AppError("Questa email ha già firmato lo scarico per questa prenotazione.", 409);
  }

  const cancelToken = createManageToken();
  const signatureId = id("waiver");
  waiverSignatures.push({
    id: signatureId,
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
  if (demoWaiverSummary(booking).signedCount >= booking.playerCount) {
    booking.status = "CONFIRMED";
    booking.signatureConfirmedAt = new Date();
    booking.updatedAt = new Date();
    addAudit(signerEmail, "BOOKING_SIGNATURES_COMPLETED", "Booking", booking.id);
  }
  addAudit(signerEmail, "WAIVER_SIGNED", "WaiverSignature", booking.id);

  // Campo extra ignorato dal chiamante prod (signGuestWaiver): in demo consegna l'URL di rinuncia
  // col token vero — altrimenti il cancelToken resta hashato e irrecuperabile e la rinuncia ospite
  // non e' esercitabile end-to-end nei test.
  const context = await demoGetWaiverContext(bookingId, token);
  return {
    ...context,
    guestWaiverCancelUrl: buildGuestWaiverCancelUrl(baseUrl, signatureId, cancelToken),
  };
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
    canCancel: computeGuestSeatCancelable(signature.status, booking),
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
  demoProcessDeadlines();
  const signature = waiverSignatures.find((item) => item.id === signatureId);
  if (!signature) throw new AppError("Firma waiver non trovata.", 404);

  assertDemoGuestCancelAccess(signature, token);
  return demoCancelContext(signature);
}

export async function demoCancelGuestWaiverSignature(signatureId: string, token: string | null) {
  demoProcessDeadlines();
  const signature = waiverSignatures.find((item) => item.id === signatureId);
  if (!signature) throw new AppError("Firma waiver non trovata.", 404);

  assertDemoGuestCancelAccess(signature, token);
  const booking = bookings.find((item) => item.id === signature.bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  // Dopo l'early-return: chi ha gia' rinunciato deve ricevere la risposta idempotente, non
  // un "la partita e' gia' iniziata" che gli racconta una storia diversa da quella vera.
  if (signature.status === "CANCELED") {
    return demoCancelContext(signature);
  }

  if (booking.start <= new Date()) {
    throw new AppError(
      "La partita è già iniziata: non è più possibile rinunciare al posto.",
      409,
    );
  }

  if (booking.status !== "CONFIRMED" && booking.status !== "PENDING_SIGNATURES") {
    throw new AppError("La prenotazione non è più attiva.", 409);
  }

  signature.status = "CANCELED";
  signature.canceledAt = new Date();
  addAudit(signature.signerEmail, "WAIVER_SIGNATURE_CANCELED", "WaiverSignature", signature.id);

  if (booking.status === "CONFIRMED" && demoWaiverSummary(booking).signedCount < booking.playerCount) {
    booking.status = "PENDING_SIGNATURES";
    booking.signatureDeadlineAt = signatureReplacementDeadlineAt(booking.start);
    booking.signatureWindowStartedAt = new Date();
    booking.signatureReminderSentAt = null;
    booking.signatureConfirmedAt = null;
    booking.updatedAt = new Date();
    addAudit(signature.signerEmail, "BOOKING_SIGNATURES_INCOMPLETE", "Booking", booking.id);
  }

  return demoCancelContext(signature);
}

export function demoReset() {
  bookings.splice(0);
  blocks.splice(0);
  audit.splice(0);
  waiverSignatures.splice(0);
}
