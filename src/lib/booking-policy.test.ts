import { describe, expect, it } from "vitest";
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

  it("rifiuta piu di 2 prenotazioni future attive", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T10:00:00.000Z"),
      end: new Date("2026-06-04T11:00:00.000Z"),
      now,
      futureBookingCount: bookingPolicy.maxFutureBookings,
    });

    expect(errors).toContain("Hai gia' 2 prenotazioni future attive.");
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
});
