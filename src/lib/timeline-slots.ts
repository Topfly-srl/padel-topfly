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
// Le prenotazioni nate prima della fascia oraria (o comunque fuori) restano valide: se la
// griglia disegnasse solo gli slot della fascia, uno slot occupato alle 22:00 sparirebbe dal
// calendario e la prenotazione sembrerebbe annullata. Gli slot fuori fascia occupati vengono
// quindi aggiunti alla griglia, marcati occupati e non selezionabili; quelli liberi restano
// fuori, perche' li' non si puo' prenotare.
function occupiedOutOfWindowOptions(
  options: readonly string[],
  selectedDate: string,
  ranges: Array<{ startMs: number; endMs: number }>,
  slotMinutes: number,
) {
  if (ranges.length === 0) return [];

  const pad = (value: number) => value.toString().padStart(2, "0");
  const known = new Set(options);
  const extras: string[] = [];

  for (let minutes = 0; minutes < 24 * 60; minutes += slotMinutes) {
    const option = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    if (known.has(option)) continue;

    const slotStartMs = new Date(`${selectedDate}T${option}:00`).getTime();
    const slotEndMs = slotStartMs + slotMinutes * 60_000;
    if (ranges.some((range) => rangeOverlapsMs(slotStartMs, slotEndMs, range.startMs, range.endMs))) {
      extras.push(option);
    }
  }

  return extras;
}

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
  // La propria prenotazione (ignoreBookingId) non genera slot extra: in modifica i nuovi orari
  // devono comunque stare nella fascia, e uno slot fuori fascia "libero" sarebbe un invito falso.
  const occupiedRanges = [
    ...bookingRanges.filter((range) => range.item.id !== ignoreBookingId),
    ...blockRanges,
  ];
  const allOptions = [
    ...options,
    ...occupiedOutOfWindowOptions(options, selectedDate, occupiedRanges, slotMinutes),
  ].sort();

  return allOptions.map((option) => {
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
