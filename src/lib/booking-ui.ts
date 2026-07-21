import type { AvailabilityBooking } from "@/lib/types";

// Helper condivisi tra il calendario pubblico (booking-app) e il pannello admin:
// formattatori di data/ora, tono degli stati e utility per gli errori di rete.
// Estratti da booking-app.tsx per non duplicarli nei componenti admin.

export type Notice = {
  type: "success" | "error" | "info" | "warning";
  text: string;
};

export function pad(value: number) {
  return value.toString().padStart(2, "0");
}

export function dateTimeFromParts(day: string, time: string) {
  return new Date(`${day}T${time}:00`);
}

export function localTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function localDay(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(date);
}

export function localDateTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
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
