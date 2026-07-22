import type { WaiverEmailStatus } from "@/generated/prisma/client";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";
import { appConfig } from "@/lib/config";
import { normalizeCancelReason } from "@/lib/cancel-reason";
import {
  statsWeekWindowStart,
  summarizeCancellations,
  summarizeStartHours,
  summarizeStatuses,
  summarizeWeeks,
} from "@/lib/admin-stats";
import { AppError } from "@/lib/errors";
import {
  createManageToken,
  hashManageToken,
  isManageTokenValid,
  manageTokenExpiresAt,
  normalizeEmail,
  normalizePersonName,
} from "@/lib/manage-token";
import { availabilityOrganizerLabel } from "@/lib/booking-copy";
import { assertDateParam, zonedDayBounds } from "@/lib/time";
import {
  signatureDeadlineAt,
  signatureReminderDueAt,
  signatureReplacementDeadlineAt,
} from "@/lib/signature-workflow";
import type {
  AdminStats,
  AuditAction,
  AuditItem,
  AuditPage,
  AvailabilityBlock,
  AvailabilityBooking,
  CurrentUser,
  MyBooking,
} from "@/lib/types";
import { computeGuestSeatCancelable, summarizeWaiverSignatures } from "@/lib/waiver-service";
import type { WaiverEvidence, WaiverInput } from "@/lib/waiver-service";
import { waiverRegulationPath } from "@/lib/waiver-pdf";

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
  cancelReason: string | null;
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
  signerRole: "ORGANIZER" | "GUEST";
  signerName: string;
  signerEmail: string;
  emailStatus: WaiverEmailStatus;
  signerEmailStatus: WaiverEmailStatus;
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
  return summarizeWaiverSignatures({
    playerCount: booking.playerCount,
    waiverRevision: booking.waiverRevision,
    waiverSignatures: waiverSignatures.filter((signature) => signature.bookingId === booking.id),
  });
}

function isDemoActiveBooking(booking: DemoBooking, now = new Date()) {
  return (
    booking.status === "CONFIRMED" ||
    (booking.status === "PENDING_SIGNATURES" &&
      (!booking.signatureDeadlineAt || booking.signatureDeadlineAt > now))
  );
}

// Gemello in-memory dell'orchestrazione del cron scadenze (processSignatureDeadlines). Gira in testa
// a quasi ogni funzione pubblica del demo (pulizia opportunistica immediata: nessun throttle, che in
// memoria non risparmierebbe nulla e romperebbe solo il determinismo) e viene anche invocato in modo
// diretto dall'harness di parita' passando un `now` fisso, cosi' l'esito (quanti sollecitati, quanti
// chiusi, quali stati) si confronta con quello di processSignatureDeadlines su Postgres. Restituisce
// i conteggi come la twin Prisma; i chiamanti interni li ignorano. NON esiste il battito ne' la
// potatura audit: quelli vivono solo sul cron reale (heartbeat solo dalla route cron).
export function demoProcessDeadlines(now = new Date()) {
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

  return { reminded, canceled };
}

function addAudit(
  actorEmail: string,
  action: string,
  entityType: string,
  entityId?: string,
  cancelReason?: string | null,
) {
  audit.unshift({
    id: id("audit"),
    actorEmail,
    action,
    entityType,
    entityId: entityId ?? null,
    createdAt: new Date().toISOString(),
    cancelReason: cancelReason ?? null,
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
    cancelReason: booking.cancelReason,
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
  enforceEndOfDay = true,
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
    enforceEndOfDay,
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

export async function demoGetAvailability(
  dateValue: string | null,
  viewer?: { role?: CurrentUser["role"] | null } | null,
) {
  demoProcessDeadlines();
  const date = assertDateParam(dateValue);
  const bounds = zonedDayBounds(date);

  return {
    date,
    settings: {
      ...bookingPolicy,
      allowedDomain: appConfig.allowedDomain,
      timeZone: appConfig.timeZone,
    },
    bookings: bookings
      .filter(
        (booking) =>
          isDemoActiveBooking(booking) &&
          rangesOverlap(bounds.start, bounds.end, booking.start, booking.end),
      )
      .map((booking) => ({
        ...bookingToApi(booking),
        organizerName: availabilityOrganizerLabel(booking.organizerName, viewer?.role),
      })),
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
    cancelReason: null,
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
    signerRole: "ORGANIZER",
    signerName: identity.organizerName,
    signerEmail: identity.organizerEmail,
    emailStatus: "SKIPPED",
    signerEmailStatus: "SKIPPED",
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
  input: {
    start?: Date;
    end?: Date;
    status?: "PENDING_SIGNATURES" | "CONFIRMED" | "CANCELED";
    playerCount?: number;
    cancelReason?: string | null;
  },
) {
  demoProcessDeadlines();
  const booking = bookings.find((item) => item.id === bookingId);

  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  const isAdmin = access.adminUser?.role === "ADMIN";

  if (input.status && !isAdmin) {
    throw new AppError("Usa il comando cancella per annullare la prenotazione.", 403);
  }

  // Come in produzione: una prenotazione annullata non e' riattivabile dal referente (un tab
  // stantio non deve farla risorgere); la riattivazione resta un gesto deliberato e solo admin.
  if (booking.status === "CANCELED" && !isAdmin) {
    throw new AppError("La prenotazione è stata annullata: non è più modificabile.", 409);
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
    // Come in produzione: il vincolo della mezzanotte vale solo per lo spostamento su un nuovo
    // slot, cosi' una prenotazione esistente resta modificabile finche' non si cambia l'orario.
    assertDemoBookingAllowed(booking.organizerEmail, nextStart, nextEnd, booking.id, timeChanged);
  }

  const isCancellation = booking.status !== "CANCELED" && nextStatus === "CANCELED";
  // Come in produzione: la causale la scrivo solo quando l'annullamento avviene e la azzero quando
  // lo stato torna attivo, cosi' un motivo non resta appeso a uno slot di nuovo valido.
  if (isCancellation) {
    booking.cancelReason = normalizeCancelReason(input.cancelReason);
  } else if (nextStatus !== "CANCELED") {
    booking.cancelReason = null;
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
  // Come in produzione: ogni CONFIRMED forzato dall'admin rinnova l'istante di conferma (che in
  // produzione e' anche la componente della chiave di idempotenza dell'evento Outlook).
  if (input.status === "CONFIRMED") {
    booking.signatureConfirmedAt = new Date();
    booking.autoCanceledAt = null;
  }
  booking.updatedAt = new Date();
  addAudit(
    actorEmail,
    nextStatus === "CONFIRMED" ? "BOOKING_UPDATED" : "BOOKING_STATUS_CHANGED",
    "Booking",
    booking.id,
    isCancellation ? booking.cancelReason : null,
  );

  return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl, guestWaiverToken);
}

export async function demoCancelBooking(
  access: DemoAccess,
  bookingId: string,
  input: { cancelReason?: string | null } = {},
) {
  demoProcessDeadlines();
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) throw new AppError("Prenotazione non trovata.", 404);

  const actorEmail = assertDemoAccess(booking, access);
  if (booking.status === "CANCELED") {
    return managedBookingToApi(booking, access.manageToken ?? undefined, access.baseUrl);
  }

  booking.status = "CANCELED";
  booking.cancelReason = normalizeCancelReason(input.cancelReason);
  booking.updatedAt = new Date();
  addAudit(actorEmail, "BOOKING_CANCELED", "Booking", booking.id, booking.cancelReason);

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

export async function demoGetAdminAudit(
  input: { action?: AuditAction; cursor?: string; limit?: number } = {},
): Promise<AuditPage> {
  const limit = Math.min(Math.max(input.limit ?? 40, 10), 100);
  const filtered = input.action ? audit.filter((item) => item.action === input.action) : audit;
  // Il cursore e' l'id dell'ultima riga della pagina precedente: la pagina nuova riparte subito
  // dopo, ovunque si trovi ora (l'array puo' essere cambiato). Cursore ignoto -> riparte da capo.
  const startIndex = input.cursor ? filtered.findIndex((item) => item.id === input.cursor) + 1 : 0;
  const slice = filtered.slice(startIndex, startIndex + limit + 1);
  const page = slice.slice(0, limit);
  const last = page.at(-1);

  return {
    items: page,
    nextCursor: slice.length > limit && last ? last.id : null,
  };
}

export async function demoGetAdminStats(now: Date = new Date()): Promise<AdminStats> {
  demoProcessDeadlines(now);

  const windowStart = statsWeekWindowStart(now);
  const recentStarts = bookings.filter((booking) => booking.start >= windowStart).map((booking) => booking.start);
  const allStarts = bookings.map((booking) => booking.start);
  const canceled = bookings
    .filter((booking) => booking.status === "CANCELED")
    .map((booking) => ({ autoCanceledAt: booking.autoCanceledAt, cancelReason: booking.cancelReason }));

  const byStatus = summarizeStatuses(bookings.map((booking) => ({ status: booking.status, count: 1 })));

  return {
    totalBookings: bookings.length,
    perWeek: summarizeWeeks(recentStarts, now),
    perStartHour: summarizeStartHours(allStarts),
    byStatus,
    cancellations: summarizeCancellations(canceled),
  };
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
      // Stesso percorso regolamento della twin Prisma (getWaiverContext): delegato alla costante
      // condivisa invece di riscrivere la stringa, cosi' un cambio del percorso non lascia indietro
      // il demo. La parita' su getWaiverContext lo verifica comunque dall'esterno.
      regulationUrl: waiverRegulationPath,
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
    signerRole: "GUEST",
    signerName,
    signerEmail,
    emailStatus: "SKIPPED",
    signerEmailStatus: "SKIPPED",
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

// Seed diretto per l'harness di parita' sui flussi firma: costruisce una prenotazione con la firma
// dell'organizzatore gia' presente e, se richiesto, una firma ospite annullabile, restituendo i
// token IN CHIARO (guest waiver e rinuncia) — che il flusso reale salva solo come hash e non
// espone mai. E' il gemello in-memory di prisma.booking.create + insertSignature usati dal lato
// integrazione: serve SOLO ai test, per portare i due attuatori allo stesso stato di partenza (una
// pending con la finestra gia' chiusa, o una CONFIRMED con un posto ospite da rinunciare) che le
// funzioni pubbliche non sanno costruire (la create rifiuta il passato e non restituisce il token
// di rinuncia). NON e' usato dal codice di produzione.
export function demoSeedGuestBooking(input: {
  start: Date;
  end: Date;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  signatureDeadlineAt?: Date | null;
  playerCount?: number;
  withGuestSignature?: boolean;
  organizerName?: string;
  organizerEmail?: string;
  guestName?: string;
  guestEmail?: string;
}) {
  const now = new Date();
  const status = input.status ?? "CONFIRMED";
  const playerCount = input.playerCount ?? 2;
  const organizerName = normalizePersonName(input.organizerName ?? "Luca Bianchi");
  const organizerEmail = normalizeEmail(input.organizerEmail ?? "luca.bianchi@example.com");
  const guestWaiverToken = createManageToken();
  const bookingId = id("booking");

  bookings.push({
    id: bookingId,
    start: input.start,
    end: input.end,
    status,
    organizerEmail,
    organizerName,
    manageTokenHash: null,
    manageTokenExpiresAt: null,
    playerCount,
    waiverRevision: 1,
    signatureDeadlineAt: input.signatureDeadlineAt ?? null,
    signatureWindowStartedAt: now,
    signatureReminderSentAt: null,
    signatureConfirmedAt: status === "CONFIRMED" ? now : null,
    autoCanceledAt: null,
    cancelReason: null,
    guestWaiverTokenHash: hashManageToken(guestWaiverToken),
    guestWaiverTokenExpiresAt: manageTokenExpiresAt(input.end),
    createdAt: now,
    updatedAt: now,
  });

  waiverSignatures.push({
    id: id("waiver"),
    bookingId,
    bookingRevision: 1,
    status: "ACTIVE",
    signerRole: "ORGANIZER",
    signerName: organizerName,
    signerEmail: organizerEmail,
    emailStatus: "SENT",
    signerEmailStatus: "SENT",
    cancelTokenHash: null,
    cancelTokenExpiresAt: null,
    canceledAt: null,
    signedAt: now,
  });

  let signatureId: string | undefined;
  let cancelToken: string | undefined;
  if (input.withGuestSignature) {
    cancelToken = createManageToken();
    signatureId = id("waiver");
    waiverSignatures.push({
      id: signatureId,
      bookingId,
      bookingRevision: 1,
      status: "ACTIVE",
      signerRole: "GUEST",
      signerName: normalizePersonName(input.guestName ?? "Marco Verdi"),
      signerEmail: normalizeEmail(input.guestEmail ?? "marco.verdi@example.com"),
      emailStatus: "SENT",
      signerEmailStatus: "SKIPPED",
      cancelTokenHash: hashManageToken(cancelToken),
      cancelTokenExpiresAt: manageTokenExpiresAt(input.end),
      canceledAt: null,
      signedAt: now,
    });
  }

  return { bookingId, guestWaiverToken, signatureId, cancelToken };
}

// Seed diretto per l'harness di parita' sui flussi di GESTIONE (update/cancel): costruisce una
// prenotazione con la firma dell'organizzatore gia' presente e un manage token IN CHIARO — che il
// flusso reale salva solo come hash e non espone mai — cosi' il referente puo' esercitare
// update/cancel su uno stato che la create pubblica non sa costruire (una partita gia' iniziata: la
// create rifiuta il passato e non restituisce il token). E' il gemello in-memory di
// prisma.booking.create + insertSignature usati dal lato integrazione: serve SOLO ai test, per
// portare i due attuatori allo stesso stato di partenza. NON e' usato dal codice di produzione.
export function demoSeedManagedBooking(input: {
  start: Date;
  end: Date;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  playerCount?: number;
  withGuestSignature?: boolean;
  signatureDeadlineAt?: Date | null;
  organizerName?: string;
  organizerEmail?: string;
}) {
  const now = new Date();
  const status = input.status ?? "CONFIRMED";
  const playerCount = input.playerCount ?? 2;
  const organizerName = normalizePersonName(input.organizerName ?? "Luca Bianchi");
  const organizerEmail = normalizeEmail(input.organizerEmail ?? "luca.bianchi@example.com");
  const manageToken = createManageToken();
  const guestWaiverToken = createManageToken();
  const bookingId = id("booking");

  bookings.push({
    id: bookingId,
    start: input.start,
    end: input.end,
    status,
    organizerEmail,
    organizerName,
    manageTokenHash: hashManageToken(manageToken),
    manageTokenExpiresAt: manageTokenExpiresAt(input.end),
    playerCount,
    waiverRevision: 1,
    signatureDeadlineAt: input.signatureDeadlineAt ?? null,
    signatureWindowStartedAt: now,
    signatureReminderSentAt: null,
    signatureConfirmedAt: status === "CONFIRMED" ? now : null,
    autoCanceledAt: null,
    cancelReason: null,
    guestWaiverTokenHash: hashManageToken(guestWaiverToken),
    guestWaiverTokenExpiresAt: manageTokenExpiresAt(input.end),
    createdAt: now,
    updatedAt: now,
  });

  waiverSignatures.push({
    id: id("waiver"),
    bookingId,
    bookingRevision: 1,
    status: "ACTIVE",
    signerRole: "ORGANIZER",
    signerName: organizerName,
    signerEmail: organizerEmail,
    emailStatus: "SENT",
    signerEmailStatus: "SENT",
    cancelTokenHash: null,
    cancelTokenExpiresAt: null,
    canceledAt: null,
    signedAt: now,
  });

  if (input.withGuestSignature) {
    waiverSignatures.push({
      id: id("waiver"),
      bookingId,
      bookingRevision: 1,
      status: "ACTIVE",
      signerRole: "GUEST",
      signerName: normalizePersonName("Marco Verdi"),
      signerEmail: normalizeEmail("marco.verdi@example.com"),
      emailStatus: "SENT",
      signerEmailStatus: "SKIPPED",
      cancelTokenHash: null,
      cancelTokenExpiresAt: null,
      canceledAt: null,
      signedAt: now,
    });
  }

  return { bookingId, manageToken, guestWaiverToken };
}

// Lettura diretta di stato e scadenza firme di una prenotazione: gemello in-memory di
// prisma.booking.findUnique, serve all'harness di parita' per verificare la finestra di
// sostituzione dopo una rinuncia senza passare dalla disponibilita' (che dipende dalla chiave del
// giorno). NON usato dal codice di produzione.
export function demoReadBookingSnapshot(bookingId: string) {
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) return null;
  return {
    status: booking.status,
    signatureDeadlineMs: booking.signatureDeadlineAt?.getTime() ?? null,
  };
}

// Seed diretto per l'harness di parita' sul PROCESSO SCADENZE: costruisce una pending (o CONFIRMED)
// con scadenza, finestra e stato sollecito scelti a mano e un numero preciso di firme ACTIVE, cosi'
// il cron in memoria e quello Prisma partono dallo stesso terreno. E' il gemello in-memory di
// prisma.booking.create + insertSignature usati dal lato integrazione (createBookingRow): serve SOLO
// ai test, per costruire stati che la create pubblica non sa produrre (deadline gia' passata, firme
// preesistenti, sollecito gia' inviato). NON e' usato dal codice di produzione.
export function demoSeedPendingBooking(input: {
  start: Date;
  end?: Date;
  signatureDeadlineAt: Date | null;
  signatureWindowStartedAt?: Date | null;
  signatureReminderSentAt?: Date | null;
  status?: "PENDING_SIGNATURES" | "CONFIRMED";
  playerCount?: number;
  signedCount?: number;
}) {
  const now = new Date();
  const end = input.end ?? new Date(input.start.getTime() + 60 * 60_000);
  const status = input.status ?? "PENDING_SIGNATURES";
  const playerCount = input.playerCount ?? 2;
  const bookingId = id("booking");

  bookings.push({
    id: bookingId,
    start: input.start,
    end,
    status,
    organizerEmail: normalizeEmail(`org-${Math.random().toString(36).slice(2)}@example.com`),
    organizerName: "Mario Rossi",
    manageTokenHash: null,
    manageTokenExpiresAt: null,
    playerCount,
    waiverRevision: 1,
    signatureDeadlineAt: input.signatureDeadlineAt,
    signatureWindowStartedAt: input.signatureWindowStartedAt ?? null,
    signatureReminderSentAt: input.signatureReminderSentAt ?? null,
    signatureConfirmedAt: status === "CONFIRMED" ? now : null,
    autoCanceledAt: null,
    cancelReason: null,
    guestWaiverTokenHash: null,
    guestWaiverTokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const signedCount = input.signedCount ?? 0;
  for (let index = 0; index < signedCount; index += 1) {
    waiverSignatures.push({
      id: id("waiver"),
      bookingId,
      bookingRevision: 1,
      status: "ACTIVE",
      signerRole: index === 0 ? "ORGANIZER" : "GUEST",
      signerName: `Firmatario ${index + 1}`,
      signerEmail: normalizeEmail(`signer-${index}-${Math.random().toString(36).slice(2)}@example.com`),
      emailStatus: "SENT",
      signerEmailStatus: index === 0 ? "SENT" : "SKIPPED",
      cancelTokenHash: null,
      cancelTokenExpiresAt: null,
      canceledAt: null,
      signedAt: now,
    });
  }

  return { bookingId };
}

// Lettura diretta dell'esito del processo scadenze su una prenotazione: gemello in-memory di
// prisma.booking.findUnique per l'harness di parita' del cron. Espone solo cio' che DEVE coincidere
// tra i due lati (stato finale, sollecito inviato, chiusura automatica), non i timestamp assoluti.
// NON usato dal codice di produzione.
export function demoReadDeadlineSnapshot(bookingId: string) {
  const booking = bookings.find((item) => item.id === bookingId);
  if (!booking) return null;
  return {
    status: booking.status,
    reminderSent: booking.signatureReminderSentAt !== null,
    autoCanceled: booking.autoCanceledAt !== null,
  };
}

export function demoReset() {
  bookings.splice(0);
  blocks.splice(0);
  audit.splice(0);
  waiverSignatures.splice(0);
}
