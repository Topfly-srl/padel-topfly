import { describe, expect, it } from "vitest";
import { bookingDurationOptions } from "@/lib/booking-constants";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";

const now = new Date("2026-06-03T10:00:00.000Z");

describe("booking policy", () => {
  it("accetta una prenotazione valida da 60 minuti", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T10:00:00.000Z"),
      end: new Date("2026-06-04T11:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toEqual([]);
  });

  it("rifiuta durate non arrotondate a 15 minuti", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T10:00:00.000Z"),
      end: new Date("2026-06-04T10:40:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toContain("La durata deve essere arrotondata a step da 15 minuti.");
  });

  it("rifiuta prenotazioni oltre 14 giorni", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-18T10:00:00.000Z"),
      end: new Date("2026-06-18T11:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toContain("Puoi prenotare al massimo 14 giorni in anticipo.");
  });

  it("accetta tutto il quattordicesimo giorno locale", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-17T21:45:00.000Z"),
      end: new Date("2026-06-17T22:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toEqual([]);
  });

  it("rifiuta dal giorno locale successivo al quattordicesimo", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-17T22:00:00.000Z"),
      end: new Date("2026-06-17T22:15:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toContain("Puoi prenotare al massimo 14 giorni in anticipo.");
  });

  it("rifiuta piu di 2 prenotazioni future attive", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T10:00:00.000Z"),
      end: new Date("2026-06-04T11:00:00.000Z"),
      now,
      futureBookingCount: bookingPolicy.maxFutureBookings,
    });

    expect(errors).toContain("Hai già 2 prenotazioni future attive.");
  });

  it("rileva sovrapposizioni tra fasce", () => {
    expect(
      rangesOverlap(
        new Date("2026-06-04T10:00:00.000Z"),
        new Date("2026-06-04T11:00:00.000Z"),
        new Date("2026-06-04T10:30:00.000Z"),
        new Date("2026-06-04T11:30:00.000Z"),
      ),
    ).toBe(true);
  });

  it("considera allineati solo orari a step da 15 minuti", () => {
    expect(isAlignedToSlot(new Date("2026-06-04T10:15:00.000Z"))).toBe(true);
    expect(isAlignedToSlot(new Date("2026-06-04T10:10:00.000Z"))).toBe(false);
  });

  it("espone tutte le durate selezionabili a step da 15 minuti", () => {
    expect(bookingDurationOptions).toEqual([15, 30, 45, 60, 75, 90, 105, 120]);
    expect(bookingPolicy.durationOptions).toEqual(bookingDurationOptions);
  });

  it.each([45, 75, 90, 105, 120])(
    "mantiene coerente la copertura visuale per durate da %i minuti",
    (minutes) => {
      const start = new Date("2026-06-04T18:00:00.000Z");
      const end = new Date(start.getTime() + minutes * 60_000);
      const slots = Array.from({ length: 9 }, (_, index) => {
        const slotStart = new Date(start.getTime() + index * 15 * 60_000);
        const slotEnd = new Date(slotStart.getTime() + 15 * 60_000);
        return rangesOverlap(slotStart, slotEnd, start, end);
      });

      expect(slots.filter(Boolean)).toHaveLength(minutes / 15);
      expect(slots[0]).toBe(true);
      expect(slots[minutes / 15]).toBe(false);
    },
  );
});
