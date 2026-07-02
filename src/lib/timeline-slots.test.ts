import { describe, expect, it } from "vitest";
import {
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
});
