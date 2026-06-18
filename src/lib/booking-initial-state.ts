import { addDays, addMinutes, format, parseISO } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

export type BookingInitialState = {
  date: string;
  time: string;
  dateKeys: string[];
};

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function roundedQuarterHour(now: Date, timeZone: string) {
  const zoned = toZonedTime(addMinutes(now, 15), timeZone);
  zoned.setSeconds(0, 0);

  const roundedMinutes = Math.ceil(zoned.getMinutes() / 15) * 15;
  zoned.setMinutes(roundedMinutes === 60 ? 0 : roundedMinutes);
  if (roundedMinutes === 60) {
    zoned.setHours(zoned.getHours() + 1);
  }

  return {
    date: format(zoned, "yyyy-MM-dd"),
    time: `${pad(zoned.getHours())}:${pad(zoned.getMinutes())}`,
  };
}

export function createBookingInitialState(
  now: Date,
  timeZone: string,
  days = 15,
): BookingInitialState {
  const today = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  const currentTime = formatInTimeZone(now, timeZone, "HH:mm");
  const preferredTime = "18:00";
  const selection =
    currentTime < preferredTime
      ? { date: today, time: preferredTime }
      : roundedQuarterHour(now, timeZone);

  return {
    ...selection,
    dateKeys: Array.from({ length: days }, (_, index) =>
      format(addDays(parseISO(today), index), "yyyy-MM-dd"),
    ),
  };
}
