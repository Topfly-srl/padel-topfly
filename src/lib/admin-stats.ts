import type { BookingStatus } from "@/generated/prisma/client";
import { addWeeks, format, parseISO, startOfWeek } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { appConfig } from "@/lib/config";
import { cancelReasonOtherLabel, cancelReasonPresets, normalizeCancelReason } from "@/lib/cancel-reason";
import type { AdminStats } from "@/lib/types";

// Set dei preset noti: solo queste causali finiscono verbatim nel breakdown. Qualsiasi testo libero
// ("Altro") viene collassato sotto un'unica etichetta generica, cosi' un eventuale nome digitato nel
// campo libero non compare mai nelle statistiche (invariante: le statistiche non espongono nomi).
const knownCancelReasons = new Set<string>(cancelReasonPresets);

// Aggregazioni pure per le statistiche admin, condivise da prod (booking-service) e demo (demo-store):
// il comportamento sta qui una volta sola, i due lati gli passano solo array di primitivi. Cosi' i
// test sull'aggregazione girano sulla demo senza database e il ramo prod non ricopia la logica.

// Ultime 8 settimane, come da specifica.
export const statsWeekCount = 8;

// L'ordine con cui lo stato corrente viene sempre mostrato: conteggi a zero inclusi, cosi' la
// tabella non salta righe quando una categoria e' vuota.
const statusOrder: BookingStatus[] = ["PENDING_SIGNATURES", "CONFIRMED", "CANCELED"];

// Data di calendario (yyyy-MM-dd) nel fuso configurato, riportata a mezzanotte per la sola aritmetica
// dei giorni: conta il giorno di parete, non l'offset. Settimana che inizia di lunedi'.
function zonedCalendarDate(date: Date): Date {
  return parseISO(`${formatInTimeZone(date, appConfig.timeZone, "yyyy-MM-dd")}T00:00:00`);
}

function zonedMonday(date: Date): Date {
  return startOfWeek(zonedCalendarDate(date), { weekStartsOn: 1 });
}

function weekStartKey(date: Date): string {
  return format(zonedMonday(date), "yyyy-MM-dd");
}

// Istante UTC del lunedi' 00:00 (fuso app) piu' vecchio della finestra: limita la query prod cosi'
// non trascina l'intera storia solo per contare 8 settimane.
export function statsWeekWindowStart(now: Date): Date {
  const oldestMonday = format(addWeeks(zonedMonday(now), -(statsWeekCount - 1)), "yyyy-MM-dd");
  return fromZonedTime(`${oldestMonday}T00:00:00`, appConfig.timeZone);
}

export function summarizeWeeks(starts: Date[], now: Date): AdminStats["perWeek"] {
  const currentMonday = zonedMonday(now);
  const keys: string[] = [];
  for (let offset = statsWeekCount - 1; offset >= 0; offset -= 1) {
    keys.push(format(addWeeks(currentMonday, -offset), "yyyy-MM-dd"));
  }

  const counts = new Map<string, number>(keys.map((key) => [key, 0]));
  for (const start of starts) {
    const key = weekStartKey(start);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return keys.map((weekStart) => ({ weekStart, count: counts.get(weekStart) ?? 0 }));
}

export function summarizeStartHours(starts: Date[]): AdminStats["perStartHour"] {
  const counts = new Map<number, number>();
  for (const start of starts) {
    const hour = Number(formatInTimeZone(start, appConfig.timeZone, "H"));
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour - b.hour);
}

export function summarizeStatuses(entries: Array<{ status: BookingStatus; count: number }>): AdminStats["byStatus"] {
  const counts = new Map<BookingStatus, number>();
  for (const entry of entries) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + entry.count);
  }

  return statusOrder.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

function percent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100);
}

export function summarizeCancellations(
  rows: Array<{ autoCanceledAt: Date | null; cancelReason: string | null }>,
): AdminStats["cancellations"] {
  const total = rows.length;
  let auto = 0;
  let manualWithoutReason = 0;
  const reasonCounts = new Map<string, number>();

  for (const row of rows) {
    if (row.autoCanceledAt) {
      auto += 1;
      continue;
    }

    const reason = normalizeCancelReason(row.cancelReason);
    if (reason) {
      // Solo i preset noti restano distinti: il testo libero confluisce tutto in "Altro" senza mai
      // riportare cio' che l'utente ha digitato (potrebbe essere un nome).
      const bucket = knownCancelReasons.has(reason) ? reason : cancelReasonOtherLabel;
      reasonCounts.set(bucket, (reasonCounts.get(bucket) ?? 0) + 1);
    } else {
      manualWithoutReason += 1;
    }
  }

  const manual = total - auto;
  const reasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    total,
    auto,
    manual,
    autoPercent: percent(auto, total),
    manualPercent: percent(manual, total),
    reasons,
    manualWithoutReason,
  };
}
