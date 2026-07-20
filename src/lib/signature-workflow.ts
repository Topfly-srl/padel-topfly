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

const minSignatureWindowMs = 24 * 60 * 60_000;
const maxSignatureWindowMs = 4 * 24 * 60 * 60_000;
const signatureWindowRatio = 0.5;
const signatureCutoffBeforeStartMs = 4 * 60 * 60_000;
const lastMinuteDeadlineMs = 30 * 60_000;
const replacementWindowMs = 2 * 60 * 60_000;
const reminderLeadMs = 6 * 60 * 60_000;

type BookingWithSignatureDeadlineFields = Pick<
  Booking,
  "start" | "signatureDeadlineAt"
>;

// Il reminder deve cadere a meta' della finestra, non a un anticipo fisso: con lead fisso una
// prenotazione con finestra piu' corta del lead riceve il sollecito subito dopo la creazione,
// quando non c'e' ancora nulla da sollecitare, e poi resta senza avvisi fino all'annullamento.
// La finestra parte da signatureWindowStartedAt, non da createdAt: dopo una rinuncia (o una
// modifica che azzera le firme) l'inizio si sposta ad adesso, cosi' una prenotazione nata giorni
// prima non risulta con il sollecito gia' scaduto e non riceve due mail nello stesso istante.
export function signatureReminderDueAt(
  booking: Pick<Booking, "createdAt" | "signatureDeadlineAt"> & {
    signatureWindowStartedAt?: Date | null;
  },
) {
  if (!booking.signatureDeadlineAt) return null;

  const windowStart = booking.signatureWindowStartedAt ?? booking.createdAt;
  const windowMs = booking.signatureDeadlineAt.getTime() - windowStart.getTime();
  const leadMs = Math.min(reminderLeadMs, Math.max(0, Math.round(windowMs / 2)));

  return new Date(booking.signatureDeadlineAt.getTime() - leadMs);
}

type GuestSigner = {
  signerName: string;
  signerEmail: string;
};

export function signatureDeadlineAt(start: Date, createdAt = new Date()) {
  const cutoffBeforeStart = new Date(start.getTime() - signatureCutoffBeforeStartMs);
  // Pavimento garantito a tutti, non solo al ramo last minute: senza, chi prenota appena sopra
  // il cutoff resta schiacciato contro di esso e riceve meno tempo di chi prenota dopo di lui
  // (4h01m prima dell'inizio -> 1 minuto per firmare, contro i 30 di chi prenota a 3h59m).
  const floor = minDate(new Date(createdAt.getTime() + lastMinuteDeadlineMs), start);

  if (cutoffBeforeStart <= createdAt) {
    return floor;
  }

  // Meta' del tempo mancante, mai meno di 24 ore e mai piu' di 4 giorni: chi prenota con largo
  // anticipo non deve raccogliere le firme entro domani, ma una pending mai firmata non deve
  // nemmeno tenere lo slot bloccato per una settimana.
  const windowMs = Math.min(
    maxSignatureWindowMs,
    Math.max(
      minSignatureWindowMs,
      Math.round((cutoffBeforeStart.getTime() - createdAt.getTime()) * signatureWindowRatio),
    ),
  );
  const deadline = minDate(new Date(createdAt.getTime() + windowMs), cutoffBeforeStart);

  return deadline >= floor ? deadline : floor;
}

// Una prenotazione confermata che perde una firma non e' una prenotazione nuova: chi resta
// deve trovare un sostituto, non ricominciare da capo. Merita quindi una finestra propria e
// non i 30 minuti del ramo last minute, che qui punirebbero chi non ha fatto nulla di male.
export function signatureReplacementDeadlineAt(start: Date, now = new Date()) {
  const standard = signatureDeadlineAt(start, now);
  const replacement = minDate(new Date(now.getTime() + replacementWindowMs), start);

  return standard >= replacement ? standard : replacement;
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
  manageUrl?: string;
}) {
  // A firme complete l'unica azione che serve nell'invito e' gestire o annullare: il link firma
  // ospiti non avrebbe piu' nessuno da mandare a firmare. Dove il token di gestione non e'
  // disponibile in chiaro (conferma innescata dall'ultima firma ospite) l'invito resta senza
  // bottoni, ma il referente ha comunque il link nella mail di prenotazione.
  const result = await createOutlookEvent(
    input.booking,
    organizerContact(input.booking),
    input.manageUrl,
  );

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

  const result = await deleteOutlookEvent(booking, "pending");

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
        // Nessun filtro su start: la deadline puo' coincidere con l'inizio (last minute e
        // sostituzioni a ridosso), quindi "scaduta E non ancora iniziata" sarebbe un insieme
        // vuoto e quelle prenotazioni resterebbero pending per sempre, con il link firma vivo.
        // Le partite gia' iniziate vengono chiuse lo stesso: sono le NOTIFICHE a essere
        // soppresse piu' sotto, perche' il danno era la mail di annullamento a posteriori.
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

    const reminderDueAt = signatureReminderDueAt(booking);
    if (reminderDueAt && reminderDueAt > now) continue;

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

    // Il claim su signatureReminderSentAt e' gia' scritto e non va resettato in caso di errore
    // (altrimenti il cron ritenterebbe l'invio ogni 10 minuti). L'audit invece riflette l'esito
    // reale: si scrive DOPO l'invio, con l'azione FAILED e il motivo quando la mail non parte.
    runAfterResponse(async () => {
      const result = await sendOrganizerSignatureReminderEmail({
        booking,
        signedCount,
      });

      await prisma.auditLog.create({
        data: {
          actorEmail: "system",
          action:
            result.status === "SENT"
              ? "BOOKING_SIGNATURE_REMINDER_SENT"
              : "BOOKING_SIGNATURE_REMINDER_FAILED",
          entityType: "Booking",
          entityId: booking.id,
          after: {
            signatureReminderSentAt: now.toISOString(),
            waiverSignedCount: signedCount,
            emailStatus: result.status,
            ...(result.status === "SENT" ? {} : { error: result.error ?? null }),
          },
        },
      });
    });
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

    // La pratica va chiusa comunque, ma su una partita gia' iniziata l'avviso di annullamento
    // arriverebbe a cose fatte: la pending viene archiviata in silenzio, senza mail assurde.
    if (result.booking.start <= now) {
      if (result.booking.outlookEventId) {
        runAfterResponse(() => cancelOutlookEventForPendingBooking(result.booking));
      }
      continue;
    }

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

  // Una riga di sintesi datata per ogni run con attivita', cosi' l'admin ha una traccia del cron
  // senza incrociare i singoli eventi. Niente riga quando non e' successo nulla: gonfierebbe la
  // tabella a ogni giro da 10 minuti.
  if (reminded + canceled > 0) {
    await prisma.auditLog.create({
      data: {
        actorEmail: "system",
        action: "SIGNATURE_DEADLINES_RUN",
        entityType: "System",
        after: { reminded, canceled },
      },
    });
  }

  return { reminded, canceled };
}

// La pulizia opportunistica gira in testa alle richieste utente: un errore della manutenzione
// non deve far fallire la richiesta che la ospita. Il cron (route interna) chiama invece
// processSignatureDeadlines direttamente, cosi' continua a vedere gli errori e a segnalarli.
export async function runOpportunisticSignatureDeadlines(input: {
  now?: Date;
  baseUrl?: string;
  limit?: number;
} = {}) {
  try {
    return await processSignatureDeadlines(input);
  } catch (error) {
    console.error("Pulizia opportunistica scadenze firme fallita.", error);
    return { reminded: 0, canceled: 0 };
  }
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
