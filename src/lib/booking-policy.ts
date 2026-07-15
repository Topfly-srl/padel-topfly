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
  durationOptions: bookingDurationOptions,
  durationPresets: bookingDurationOptions,
} as const;

export type BookingValidationInput = {
  start: Date;
  end: Date;
  now?: Date;
  futureBookingCount?: number;
};

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

  if (
    typeof input.futureBookingCount === "number" &&
    input.futureBookingCount >= bookingPolicy.maxFutureBookings
  ) {
    errors.push("Hai già 2 prenotazioni future attive.");
  }

  return errors;
}
