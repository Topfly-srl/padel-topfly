import type { BookingStatus } from "@prisma/client";

export function bookingStatusLabel(status: BookingStatus) {
  if (status === "PENDING_SIGNATURES") return "In attesa firme";
  if (status === "CONFIRMED") return "Confermata";
  return "Annullata";
}

// Sul calendario pubblico il cognome resta un'iniziale: "Antony Buffone" -> "Antony B.".
// Solo admin e contesti autenticati vedono il nome completo. normalizePersonName garantisce
// gia' trim e spazi singoli, ma qui restiamo difensivi sugli spazi multipli.
export function publicOrganizerLabel(name: string) {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return name.trim();

  const initial = tokens[tokens.length - 1][0].toUpperCase();
  return `${tokens.slice(0, -1).join(" ")} ${initial}.`;
}

// Sul calendario condiviso il cognome resta un'iniziale, ma l'admin autenticato deve continuare
// a vedere il nome intero (decisione committente). getAvailability alimenta ENTRAMBI i pubblici,
// quindi la scelta va fatta qui, su un unico helper condiviso da prod e demo per non divergere.
export function availabilityOrganizerLabel(name: string, viewerRole?: string | null) {
  return viewerRole === "ADMIN" ? name : publicOrganizerLabel(name);
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
