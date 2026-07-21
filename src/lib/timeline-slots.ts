export type TimelineRange<T extends { id: string }> = {
  item: T;
  startMs: number;
  endMs: number;
};

// Sorgente unica delle opzioni orarie della griglia: tutta la giornata a passi da slot, dalle
// 00:00 all'ultimo inizio che chiude entro la mezzanotte (23:45 con slot da 15 minuti). Generare
// qui evita di ripetere la stessa logica in booking-app e manage-booking.
export function bookingTimeOptions(slotMinutes = 15) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const options: string[] = [];

  for (let minutes = 0; minutes + slotMinutes <= 24 * 60; minutes += slotMinutes) {
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

export type TimelineSlot<B extends { id: string }, K extends { id: string }> = {
  option: string;
  booking: B | undefined;
  block: K | undefined;
  isSelected: boolean;
  isSelectedStart: boolean;
};

// Stato di ogni slot della griglia oraria (occupato/bloccato/selezionato). Prima booking-app e
// manage-booking ricostruivano questo calcolo per conto proprio (l'uno in millisecondi, l'altro con
// oggetti Date): stessa logica, due copie che potevano divergere in silenzio. Ora e' un solo helper.
// L'esclusione di una prenotazione (ignoreBookingId) copre sia la modifica in corso su booking-app
// sia il "escludi me stessa dai conflitti" di manage-booking.
export function computeTimelineSlots<B extends { id: string }, K extends { id: string }>({
  options,
  selectedDate,
  selectedTime,
  startMs,
  endMs,
  bookingRanges,
  blockRanges,
  ignoreBookingId,
  slotMinutes = 15,
}: {
  options: readonly string[];
  selectedDate: string;
  selectedTime: string;
  startMs: number;
  endMs: number;
  bookingRanges: Array<TimelineRange<B>>;
  blockRanges: Array<TimelineRange<K>>;
  ignoreBookingId?: string | null;
  slotMinutes?: number;
}): Array<TimelineSlot<B, K>> {
  return options.map((option) => {
    const slotStartMs = new Date(`${selectedDate}T${option}:00`).getTime();
    const slotEndMs = slotStartMs + slotMinutes * 60_000;
    const booking = findOverlappingTimelineItem(bookingRanges, slotStartMs, slotEndMs, ignoreBookingId);
    const block = findOverlappingTimelineItem(blockRanges, slotStartMs, slotEndMs);
    const isSelected = rangeOverlapsMs(slotStartMs, slotEndMs, startMs, endMs);

    return {
      option,
      booking,
      block,
      isSelected,
      isSelectedStart: option === selectedTime,
    };
  });
}

// Classe CSS di uno slot: gli stessi token usati da booking-app e manage-booking. Il token
// "pending-signatures" compare solo dove serve (calendario pubblico), quindi resta opzionale.
export function timeSlotClassName({
  busy,
  pending,
  blocked,
  selectedStart,
  selectedRange,
}: {
  busy: boolean;
  pending?: boolean;
  blocked: boolean;
  selectedStart: boolean;
  selectedRange: boolean;
}) {
  return [
    "time-slot",
    busy ? "busy" : "",
    pending ? "pending-signatures" : "",
    blocked ? "blocked" : "",
    selectedStart ? "selected-start" : selectedRange ? "selected-range" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
