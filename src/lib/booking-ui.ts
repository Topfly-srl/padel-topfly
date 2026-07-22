import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { AvailabilityBooking } from "@/lib/types";

// Helper condivisi tra il calendario pubblico (booking-app) e il pannello admin:
// formattatori di data/ora, tono degli stati e utility per gli errori di rete.
// Estratti da booking-app.tsx per non duplicarli nei componenti admin.
//
// Tutti gli orari dell'app sono "ora di parete" del campo: ogni helper di data/ora richiede il
// fuso IANA in coda (settings.timeZone dell'availability, o defaultTimeZone finche' non arriva).
// Niente parse o format nel fuso del dispositivo: un telefono impostato su un fuso estero
// sposterebbe silenziosamente lo slot prenotato.

export type Notice = {
  type: "success" | "error" | "info" | "warning";
  text: string;
};

export function pad(value: number) {
  return value.toString().padStart(2, "0");
}

export function dateTimeFromParts(day: string, time: string, timeZone: string) {
  // "24:00" e' ora ISO valida (mezzanotte del giorno DOPO) e il vecchio `new Date(...)` la
  // accettava; fromZonedTime invece la ripiegherebbe sulle 00:00 dello stesso giorno. La
  // normalizziamo a mano per non rompere la fine dei blocchi admin (23:45-24:00).
  if (time === "24:00") {
    const [year, month, dayOfMonth] = day.split("-").map(Number);
    const nextDay = new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10);
    return fromZonedTime(`${nextDay}T00:00:00`, timeZone);
  }

  return fromZonedTime(`${day}T${time}:00`, timeZone);
}

// Giorno (YYYY-MM-DD) e ora (HH:mm) di un istante letti nel fuso del campo: sostituiscono i
// getFullYear()/getHours() locali dei componenti (chiave del giorno selezionato, riposizionamento
// della griglia su una prenotazione esistente).
export function dayKeyInTimeZone(date: Date, timeZone: string) {
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd");
}

export function timeKeyInTimeZone(date: Date, timeZone: string) {
  return formatInTimeZone(date, timeZone, "HH:mm");
}

export function localTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

export function localDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone,
  }).format(date);
}

export function localDateTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

export function bookingStatusTone(status: AvailabilityBooking["status"]) {
  if (status === "PENDING_SIGNATURES") return "warning";
  if (status === "CONFIRMED") return "success";
  return "neutral";
}

// Etichetta di sincronizzazione Outlook mostrata sotto una prenotazione. Le PENDING_SIGNATURES non
// hanno ancora un invito reale, quindi non riportano nessuno stato. Condivisa tra il riepilogo di
// booking-app e la sezione "Le mie prenotazioni" cosi' la stessa copia non vive in due posti.
export function syncLabel(status: string, bookingStatus?: string) {
  const isCanceled = bookingStatus === "CANCELED";
  const isPendingSignatures = bookingStatus === "PENDING_SIGNATURES";

  if (isPendingSignatures) {
    return null;
  }

  if (status === "SYNCED") {
    return isCanceled ? "Cancellazione Outlook inviata" : "Invito Outlook inviato";
  }
  if (status === "FAILED") {
    return isCanceled ? "Cancellazione Outlook non riuscita" : "Email non inviata";
  }
  if (status === "PENDING") {
    return isCanceled ? "Cancellazione Outlook in preparazione" : "Invito Outlook in preparazione";
  }
  return null;
}

export async function readApiError(response: Response) {
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  return json?.error ?? "Richiesta non riuscita.";
}

export function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

// Mostrato quando fetch lancia (rete assente), non quando la risposta e' un errore applicativo.
export const networkErrorText = "Rete non disponibile. Controlla la connessione e riprova.";
