import { describe, expect, it } from "vitest";
import {
  bookingTimeOptions,
  findOverlappingTimelineItem,
  rangeOverlapsMs,
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
