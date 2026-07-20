import { defaultClosingHour, defaultOpeningHour } from "@/lib/booking-constants";

export type TimelineRange<T extends { id: string }> = {
  item: T;
  startMs: number;
  endMs: number;
};

// Sorgente unica delle opzioni orarie della griglia: genera solo gli slot il cui inizio sta nella
// fascia aperta e la cui durata minima (uno slot) termina entro la chiusura. Filtrare qui evita di
// ripetere la stessa logica in booking-app e manage-booking.
export function bookingTimeOptions(
  openingHour: number = defaultOpeningHour,
  closingHour: number = defaultClosingHour,
  slotMinutes = 15,
) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const options: string[] = [];

  for (
    let minutes = openingHour * 60;
    minutes + slotMinutes <= closingHour * 60;
    minutes += slotMinutes
  ) {
    options.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  }

  return options;
}

export function rangeOverlapsMs(
  startMs: number,
  endMs: number,
  itemStartMs: number,
  itemEndMs: number,
) {
  return startMs < itemEndMs && endMs > itemStartMs;
}

export function findOverlappingTimelineItem<T extends { id: string }>(
  ranges: Array<TimelineRange<T>>,
  startMs: number,
  endMs: number,
  ignoreItemId?: string | null,
) {
  return ranges.find(
    (range) =>
      range.item.id !== ignoreItemId &&
      rangeOverlapsMs(startMs, endMs, range.startMs, range.endMs),
  )?.item;
}
