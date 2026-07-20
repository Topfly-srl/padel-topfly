import type { BookingStatus } from "@prisma/client";

export function bookingStatusLabel(status: BookingStatus) {
  if (status === "PENDING_SIGNATURES") return "In attesa firme";
  if (status === "CONFIRMED") return "Confermata";
  return "Annullata";
}

export function bookingDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function deadlineCopy(value: string | null) {
  return value
    ? `Scadenza firme: ${bookingDateTime(new Date(value))}`
    : "Completa le firme prima dell'orario di gioco.";
}
