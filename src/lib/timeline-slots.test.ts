import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import {
  bookingTimeOptions,
  computeTimelineSlots,
  findOverlappingTimelineItem,
  rangeOverlapsMs,
  timeSlotClassName,
  type TimelineRange,
} from "@/lib/timeline-slots";

// Fuso del campo usato in tutta la suite: gli orari attesi vengono costruiti con fromZonedTime
// sullo stesso fuso passato a computeTimelineSlots, cosi' i test sono INDIPENDENTI dal fuso della
// macchina (girano identici anche con TZ=America/New_York).
const timeZone = "Europe/Rome";

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

// Le fasce della griglia usano la stessa lettura "ora di parete" di computeTimelineSlots
// (`YYYY-MM-DDTHH:MM:00` nel fuso del campo), cosi' attese e calcolo condividono la conversione.
function wallClockMs(day: string, time: string) {
  return fromZonedTime(`${day}T${time}:00`, timeZone).getTime();
}

function localRange(item: TestItem, day: string, startTime: string, endTime: string): TimelineRange<TestItem> {
  return {
    item,
    startMs: wallClockMs(day, startTime),
    endMs: wallClockMs(day, endTime),
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

  it("genera gli slot su tutta la giornata (00:00-23:45)", () => {
    const options = bookingTimeOptions();

    expect(options[0]).toBe("00:00");
    // Ultimo inizio possibile: uno slot da 15 minuti deve chiudersi entro la mezzanotte.
    expect(options.at(-1)).toBe("23:45");
    expect(options).not.toContain("24:00");
    // Dalle 00:00 alle 23:45 a passi da 15 minuti sono 96 slot.
    expect(options).toHaveLength(96);
  });

  it("rispetta un passo slot personalizzato", () => {
    const options = bookingTimeOptions(30);

    expect(options[0]).toBe("00:00");
    expect(options.at(-1)).toBe("23:30");
    expect(options).toHaveLength(48);
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
      timeZone,
      startMs: wallClockMs(day, "10:15"),
      endMs: wallClockMs(day, "10:45"),
      bookingRanges: [localRange(booked, day, "10:00", "10:30")],
      blockRanges: [],
    });

    // 10:00 e 10:15 sono coperti dalla prenotazione (fine esclusiva: 10:30 e' libero di nuovo).
    expect(slots[0]).toMatchObject({ option: "10:00", booking: booked, isSelected: false });
    expect(slots[1]).toMatchObject({ option: "10:15", booking: booked, isSelected: true, isSelectedStart: true });
    expect(slots[2]).toMatchObject({ option: "10:30", booking: undefined, isSelected: true, isSelectedStart: false });
    expect(slots[3]).toMatchObject({ option: "10:45", booking: undefined, isSelected: false });
  });

  it("copre l'intera giornata anche con prenotazioni a fine giornata", () => {
    // La partita serale 22:00-23:59 deve risultare occupata sugli ultimi slot della griglia.
    const evening = { id: "b-evening", name: "Partita serale" };
    const slots = computeTimelineSlots({
      options: bookingTimeOptions(),
      selectedDate: day,
      selectedTime: "10:00",
      timeZone,
      startMs: wallClockMs(day, "10:00"),
      endMs: wallClockMs(day, "11:00"),
      bookingRanges: [localRange(evening, day, "22:00", "23:59")],
      blockRanges: [],
    });

    expect(slots).toHaveLength(96);
    const lastEight = slots.slice(-8);
    expect(lastEight.map((slot) => slot.option)).toEqual([
      "22:00", "22:15", "22:30", "22:45", "23:00", "23:15", "23:30", "23:45",
    ]);
    for (const slot of lastEight) {
      expect(slot.booking).toBe(evening);
    }
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
      timeZone,
      startMs: wallClockMs(day, "10:00"),
      endMs: wallClockMs(day, "10:30"),
      bookingRanges: ranges,
      blockRanges: [],
    });
    const withIgnore = computeTimelineSlots({
      options,
      selectedDate: day,
      selectedTime: "10:00",
      timeZone,
      startMs: wallClockMs(day, "10:00"),
      endMs: wallClockMs(day, "10:30"),
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
      timeZone,
      startMs: wallClockMs(day, "09:00"),
      endMs: wallClockMs(day, "09:15"),
      bookingRanges: [],
      blockRanges: [localRange(block, day, "10:00", "10:15")],
    });

    expect(slots[0]).toMatchObject({ option: "10:00", block, booking: undefined });
    expect(slots[1].block).toBeUndefined();
  });

  it("ancora gli slot al fuso del campo, non a quello del processo", () => {
    // Prova regina dell'indipendenza dal dispositivo: il 3 luglio 2026 Roma e' UTC+2, quindi lo
    // slot di parete 10:00 inizia alle 08:00Z. L'atteso e' un istante ASSOLUTO (Date.UTC): se
    // computeTimelineSlots usasse il fuso del processo, il test fallirebbe appena TZ != Rome.
    const slots = computeTimelineSlots({
      options: ["10:00"],
      selectedDate: day,
      selectedTime: "10:00",
      timeZone,
      startMs: wallClockMs(day, "10:00"),
      endMs: wallClockMs(day, "10:15"),
      bookingRanges: [
        { item: { id: "utc" }, startMs: Date.UTC(2026, 6, 3, 8, 0), endMs: Date.UTC(2026, 6, 3, 8, 15) },
      ],
      blockRanges: [],
    });

    expect(wallClockMs(day, "10:00")).toBe(Date.UTC(2026, 6, 3, 8, 0));
    // La prenotazione espressa direttamente in UTC copre lo slot di parete 10:00-10:15.
    expect(slots[0].booking).toEqual({ id: "utc" });
    expect(slots[0].isSelected).toBe(true);
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
