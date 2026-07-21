import { describe, expect, it } from "vitest";
import {
  bookingTimeOptions,
  computeTimelineSlots,
  findOverlappingTimelineItem,
  rangeOverlapsMs,
  timeSlotClassName,
  type TimelineRange,
} from "@/lib/timeline-slots";

type TestItem = {
  id: string;
  name: string;
};

function range(item: TestItem, start: string, end: string): TimelineRange<TestItem> {
  return {
    item,
    startMs: new Date(start).getTime(),
    endMs: new Date(end).getTime(),
  };
}

// Le fasce della griglia usano la stessa lettura oraria "locale" di computeTimelineSlots
// (`YYYY-MM-DDTHH:MM:00`, senza Z), cosi' il test resta stabile qualunque sia il fuso della macchina.
function localRange(item: TestItem, day: string, startTime: string, endTime: string): TimelineRange<TestItem> {
  return {
    item,
    startMs: new Date(`${day}T${startTime}:00`).getTime(),
    endMs: new Date(`${day}T${endTime}:00`).getTime(),
  };
}

describe("timeline slots", () => {
  it("rileva sovrapposizioni tra fasce in millisecondi", () => {
    const start = new Date("2026-07-03T10:15:00.000Z").getTime();
    const end = new Date("2026-07-03T11:15:00.000Z").getTime();
    const itemStart = new Date("2026-07-03T10:00:00.000Z").getTime();
    const itemEnd = new Date("2026-07-03T11:00:00.000Z").getTime();

    expect(rangeOverlapsMs(start, end, itemStart, itemEnd)).toBe(true);
  });

  it("ignora la prenotazione corrente durante una modifica slot", () => {
    const current = { id: "booking-current", name: "Corrente" };
    const other = { id: "booking-other", name: "Altra prenotazione" };
    const ranges = [
      range(current, "2026-07-03T10:00:00.000Z", "2026-07-03T11:00:00.000Z"),
      range(other, "2026-07-03T11:15:00.000Z", "2026-07-03T12:15:00.000Z"),
    ];
    const shiftedStart = new Date("2026-07-03T10:15:00.000Z").getTime();
    const shiftedEnd = new Date("2026-07-03T11:15:00.000Z").getTime();

    expect(
      findOverlappingTimelineItem(ranges, shiftedStart, shiftedEnd, current.id),
    ).toBeUndefined();
  });

  it("continua a bloccare altre prenotazioni quando quella corrente viene ignorata", () => {
    const current = { id: "booking-current", name: "Corrente" };
    const other = { id: "booking-other", name: "Altra prenotazione" };
    const ranges = [
      range(current, "2026-07-03T10:00:00.000Z", "2026-07-03T11:00:00.000Z"),
      range(other, "2026-07-03T11:00:00.000Z", "2026-07-03T12:00:00.000Z"),
    ];
    const shiftedStart = new Date("2026-07-03T10:15:00.000Z").getTime();
    const shiftedEnd = new Date("2026-07-03T11:15:00.000Z").getTime();

    expect(findOverlappingTimelineItem(ranges, shiftedStart, shiftedEnd, current.id)).toBe(other);
  });

  it("genera gli slot solo dentro la fascia di apertura di default (08:00-22:00)", () => {
    const options = bookingTimeOptions();

    expect(options[0]).toBe("08:00");
    // Ultimo inizio possibile: uno slot da 15 minuti deve chiudersi entro le 22:00.
    expect(options.at(-1)).toBe("21:45");
    expect(options).not.toContain("07:45");
    expect(options).not.toContain("22:00");
    // Dalle 08:00 alle 21:45 a passi da 15 minuti sono 56 slot.
    expect(options).toHaveLength(56);
  });

  it("rispetta una fascia personalizzata", () => {
    const options = bookingTimeOptions(10, 12);

    expect(options[0]).toBe("10:00");
    expect(options.at(-1)).toBe("11:45");
    expect(options).toHaveLength(8);
  });
});

describe("computeTimelineSlots", () => {
  const day = "2026-07-03";
  const options = ["10:00", "10:15", "10:30", "10:45"];

  it("marca occupato, selezionato e inizio selezione slot per slot", () => {
    const booked = { id: "b1", name: "Altra prenotazione" };
    const slots = computeTimelineSlots({
      options,
      selectedDate: day,
      selectedTime: "10:15",
      startMs: new Date(`${day}T10:15:00`).getTime(),
      endMs: new Date(`${day}T10:45:00`).getTime(),
      bookingRanges: [localRange(booked, day, "10:00", "10:30")],
      blockRanges: [],
    });

    // 10:00 e 10:15 sono coperti dalla prenotazione (fine esclusiva: 10:30 e' libero di nuovo).
    expect(slots[0]).toMatchObject({ option: "10:00", booking: booked, isSelected: false });
    expect(slots[1]).toMatchObject({ option: "10:15", booking: booked, isSelected: true, isSelectedStart: true });
    expect(slots[2]).toMatchObject({ option: "10:30", booking: undefined, isSelected: true, isSelectedStart: false });
    expect(slots[3]).toMatchObject({ option: "10:45", booking: undefined, isSelected: false });
  });

  it("esclude la prenotazione indicata dai conflitti (parita' con manage-booking)", () => {
    const own = { id: "self", name: "La mia prenotazione" };
    const other = { id: "other", name: "Vincolo esterno" };
    const ranges = [
      localRange(own, day, "10:00", "10:30"),
      localRange(other, day, "10:30", "11:00"),
    ];

    const withoutIgnore = computeTimelineSlots({
      options,
      selectedDate: day,
      selectedTime: "10:00",
      startMs: new Date(`${day}T10:00:00`).getTime(),
      endMs: new Date(`${day}T10:30:00`).getTime(),
      bookingRanges: ranges,
      blockRanges: [],
    });
    const withIgnore = computeTimelineSlots({
      options,
      selectedDate: day,
      selectedTime: "10:00",
      startMs: new Date(`${day}T10:00:00`).getTime(),
      endMs: new Date(`${day}T10:30:00`).getTime(),
      bookingRanges: ranges,
      blockRanges: [],
      ignoreBookingId: own.id,
    });

    // Senza esclusione lo slot 10:00 risulta occupato dalla propria prenotazione.
    expect(withoutIgnore[0].booking).toBe(own);
    // Con esclusione lo slot 10:00 torna libero, ma quello di "other" resta occupato.
    expect(withIgnore[0].booking).toBeUndefined();
    expect(withIgnore[2].booking).toBe(other);
  });

  it("segnala i blocchi separatamente dalle prenotazioni", () => {
    const block = { id: "blk", name: "Manutenzione" };
    const slots = computeTimelineSlots({
      options,
      selectedDate: day,
      selectedTime: "09:00",
      startMs: new Date(`${day}T09:00:00`).getTime(),
      endMs: new Date(`${day}T09:15:00`).getTime(),
      bookingRanges: [],
      blockRanges: [localRange(block, day, "10:00", "10:15")],
    });

    expect(slots[0]).toMatchObject({ option: "10:00", block, booking: undefined });
    expect(slots[1].block).toBeUndefined();
  });
});

describe("timeSlotClassName", () => {
  it("parte da time-slot quando lo slot e' libero e non selezionato", () => {
    expect(
      timeSlotClassName({ busy: false, blocked: false, selectedStart: false, selectedRange: false }),
    ).toBe("time-slot");
  });

  it("aggiunge pending-signatures solo quando richiesto e occupato", () => {
    expect(
      timeSlotClassName({ busy: true, pending: true, blocked: false, selectedStart: false, selectedRange: false }),
    ).toBe("time-slot busy pending-signatures");
    expect(
      timeSlotClassName({ busy: true, pending: false, blocked: false, selectedStart: false, selectedRange: false }),
    ).toBe("time-slot busy");
  });

  it("l'inizio selezione ha la precedenza sulla fascia selezionata", () => {
    expect(
      timeSlotClassName({ busy: false, blocked: false, selectedStart: true, selectedRange: true }),
    ).toBe("time-slot selected-start");
    expect(
      timeSlotClassName({ busy: false, blocked: false, selectedStart: false, selectedRange: true }),
    ).toBe("time-slot selected-range");
  });

  it("combina occupato e bloccato mantenendo l'ordine dei token", () => {
    expect(
      timeSlotClassName({ busy: true, blocked: true, selectedStart: false, selectedRange: true }),
    ).toBe("time-slot busy blocked selected-range");
  });
});
