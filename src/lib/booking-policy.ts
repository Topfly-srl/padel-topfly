import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { bookingDurationOptions } from "@/lib/booking-constants";
import { appConfig } from "@/lib/config";

export const bookingPolicy = {
  slotMinutes: 15,
  minDurationMinutes: 15,
  maxDurationMinutes: 120,
  maxAdvanceDays: 14,
  maxFutureBookings: 2,
  // Fascia di apertura in ora locale del fuso configurato (default 0-24, override via env).
  openingHour: appConfig.openingHour,
  closingHour: appConfig.closingHour,
  durationOptions: bookingDurationOptions,
  durationPresets: bookingDurationOptions,
} as const;

export type BookingValidationInput = {
  start: Date;
  end: Date;
  now?: Date;
  futureBookingCount?: number;
  // Le prenotazioni gia' esistenti fuori fascia restano gestibili: la modifica che non tocca
  // lo slot passa false per non rifiutare uno slot legittimo scelto prima della regola.
  enforceOpeningHours?: boolean;
};

function formatHourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

// Minuti trascorsi dalla mezzanotte locale (fuso configurato): serve a confrontare inizio e fine
// con la fascia di apertura senza farsi ingannare dall'orario UTC sottostante.
function localMinutesOfDay(date: Date) {
  const [hours, minutes] = formatInTimeZone(date, appConfig.timeZone, "HH:mm")
    .split(":")
    .map(Number);
  return hours * 60 + minutes;
}

export function minutesBetween(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

export function rangesOverlap(
  leftStart: Date,
  leftEnd: Date,
  rightStart: Date,
  rightEnd: Date,
) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

export function isAlignedToSlot(date: Date) {
  return (
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0 &&
    date.getUTCMinutes() % bookingPolicy.slotMinutes === 0
  );
}

export function maxBookableStartAt(now = new Date()) {
  const today = formatInTimeZone(now, appConfig.timeZone, "yyyy-MM-dd");
  const parsedToday = parseISO(`${today}T00:00:00`);
  const firstBlockedDay = format(addDays(parsedToday, bookingPolicy.maxAdvanceDays + 1), "yyyy-MM-dd");

  return fromZonedTime(`${firstBlockedDay}T00:00:00`, appConfig.timeZone);
}

export function validateBookingPolicy(input: BookingValidationInput) {
  const now = input.now ?? new Date();
  const errors: string[] = [];
  const duration = minutesBetween(input.start, input.end);

  if (Number.isNaN(input.start.getTime()) || Number.isNaN(input.end.getTime())) {
    errors.push("Scegli un orario valido.");
    return errors;
  }

  if (input.start >= input.end) {
    errors.push("L'orario di fine deve essere dopo l'inizio.");
  }

  if (input.start < now) {
    errors.push("Non puoi prenotare nel passato.");
  }

  if (input.start >= maxBookableStartAt(now)) {
    errors.push("Puoi prenotare al massimo 14 giorni in anticipo.");
  }

  if (duration < bookingPolicy.minDurationMinutes) {
    errors.push("La prenotazione deve durare almeno 15 minuti.");
  }

  if (duration > bookingPolicy.maxDurationMinutes) {
    errors.push("La prenotazione può durare al massimo 120 minuti.");
  }

  if (duration % bookingPolicy.slotMinutes !== 0) {
    errors.push("La durata deve essere arrotondata a step da 15 minuti.");
  }

  if (!isAlignedToSlot(input.start) || !isAlignedToSlot(input.end)) {
    errors.push("Inizio e fine devono essere arrotondati a 15 minuti.");
  }

  if (input.enforceOpeningHours !== false) {
    const openingMinutes = bookingPolicy.openingHour * 60;
    const closingMinutes = bookingPolicy.closingHour * 60;
    const startMinutes = localMinutesOfDay(input.start);
    // La fine e' inizio locale + durata: cosi' resta coerente anche a cavallo della mezzanotte
    // senza dover gestire l'avvolgimento del giorno.
    const endMinutes = startMinutes + duration;

    if (startMinutes < openingMinutes || endMinutes > closingMinutes) {
      // Con la fascia a giornata piena (00-24) l'unica violazione possibile e' sforare la
      // mezzanotte: "prenotabile dalle 00:00 alle 24:00" suonerebbe come un controsenso.
      const fullDayBand = openingMinutes === 0 && closingMinutes === 24 * 60;
      errors.push(
        fullDayBand
          ? "La prenotazione deve terminare entro la mezzanotte."
          : `Il campo è prenotabile dalle ${formatHourLabel(bookingPolicy.openingHour)} alle ${formatHourLabel(bookingPolicy.closingHour)}.`,
      );
    }
  }

  if (
    typeof input.futureBookingCount === "number" &&
    input.futureBookingCount >= bookingPolicy.maxFutureBookings
  ) {
    errors.push("Hai già 2 prenotazioni future attive.");
  }

  return errors;
}
