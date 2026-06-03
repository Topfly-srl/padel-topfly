import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { appConfig } from "@/lib/config";

const dateParamPattern = /^\d{4}-\d{2}-\d{2}$/;

export function assertDateParam(value: string | null) {
  const date = value ?? formatInTimeZone(new Date(), appConfig.timeZone, "yyyy-MM-dd");

  if (!dateParamPattern.test(date)) {
    throw new Error("Formato data non valido.");
  }

  return date;
}

export function zonedDayBounds(date: string) {
  const parsed = parseISO(`${date}T00:00:00`);
  const next = format(addDays(parsed, 1), "yyyy-MM-dd");

  return {
    start: fromZonedTime(`${date}T00:00:00`, appConfig.timeZone),
    end: fromZonedTime(`${next}T00:00:00`, appConfig.timeZone),
  };
}

export function toDateOrThrow(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new Error(`${label} non valido.`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} non valido.`);
  }

  return date;
}

export function formatDateTimeForApp(date: Date) {
  return formatInTimeZone(date, appConfig.timeZone, "dd/MM/yyyy HH:mm");
}

export function formatTimeForApp(date: Date) {
  return formatInTimeZone(date, appConfig.timeZone, "HH:mm");
}
