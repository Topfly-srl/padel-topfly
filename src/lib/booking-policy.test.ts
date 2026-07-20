import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingDurationOptions } from "@/lib/booking-constants";
import {
  bookingPolicy,
  isAlignedToSlot,
  rangesOverlap,
  validateBookingPolicy,
} from "@/lib/booking-policy";

const now = new Date("2026-06-03T10:00:00.000Z");
// Fuso Europe/Rome in giugno = CEST (UTC+2): 08:00 locali corrispondono alle 06:00Z.
const openingBandMessage = "Il campo è prenotabile dalle 08:00 alle 22:00.";

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

  it("accetta il quattordicesimo giorno locale", () => {
    // Ultimo slot dentro la fascia di apertura del 14o giorno locale (21:45-22:00 a Roma):
    // il confine del giorno resta coperto dal test gemello sul rifiuto oltre la mezzanotte.
    const errors = validateBookingPolicy({
      start: new Date("2026-06-17T19:45:00.000Z"),
      end: new Date("2026-06-17T20:00:00.000Z"),
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

describe("fascia oraria di apertura", () => {
  it("accetta una prenotazione che inizia esattamente all'apertura (08:00)", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T06:00:00.000Z"),
      end: new Date("2026-06-04T07:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toEqual([]);
  });

  it("rifiuta una prenotazione che inizia prima dell'apertura (07:45)", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T05:45:00.000Z"),
      end: new Date("2026-06-04T06:45:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toContain(openingBandMessage);
  });

  it("accetta una prenotazione che termina esattamente alla chiusura (22:00)", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T19:00:00.000Z"),
      end: new Date("2026-06-04T20:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toEqual([]);
  });

  it("rifiuta una prenotazione che termina dopo la chiusura (22:15)", () => {
    const errors = validateBookingPolicy({
      start: new Date("2026-06-04T19:15:00.000Z"),
      end: new Date("2026-06-04T20:15:00.000Z"),
      now,
      futureBookingCount: 0,
    });

    expect(errors).toContain(openingBandMessage);
  });

  it("lascia gestibile una prenotazione esistente fuori fascia quando l'orario non cambia", () => {
    const outOfBand = {
      start: new Date("2026-06-04T01:00:00.000Z"),
      end: new Date("2026-06-04T02:00:00.000Z"),
      now,
      futureBookingCount: 0,
    };

    // Con il vincolo attivo la stessa fascia (03:00-04:00 locali) sarebbe rifiutata...
    expect(validateBookingPolicy(outOfBand)).toContain(openingBandMessage);
    // ...ma una modifica che non tocca lo slot salta il controllo e non rompe nulla.
    expect(
      validateBookingPolicy({ ...outOfBand, enforceOpeningHours: false }),
    ).toEqual([]);
  });
});

describe("fascia oraria configurabile via env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rispetta APP_OPENING_HOUR / APP_CLOSING_HOUR negli override", async () => {
    vi.resetModules();
    vi.stubEnv("APP_OPENING_HOUR", "10");
    vi.stubEnv("APP_CLOSING_HOUR", "12");

    const { validateBookingPolicy: validateWithOverride } = await import(
      "@/lib/booking-policy"
    );

    // 08:00 locali (06:00Z) ora e' fuori fascia perche' l'apertura e' alle 10:00.
    const beforeOpening = validateWithOverride({
      start: new Date("2026-06-04T06:00:00.000Z"),
      end: new Date("2026-06-04T07:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });
    expect(beforeOpening).toContain("Il campo è prenotabile dalle 10:00 alle 12:00.");

    // 10:00 locali (08:00Z) rientra nella fascia sovrascritta.
    const withinOverride = validateWithOverride({
      start: new Date("2026-06-04T08:00:00.000Z"),
      end: new Date("2026-06-04T09:00:00.000Z"),
      now,
      futureBookingCount: 0,
    });
    expect(withinOverride).toEqual([]);
  });
});
