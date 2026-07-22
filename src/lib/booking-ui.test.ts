import { describe, expect, it } from "vitest";
import {
  dateTimeFromParts,
  dayKeyInTimeZone,
  localDateTime,
  localDay,
  localTime,
  timeKeyInTimeZone,
} from "@/lib/booking-ui";

// Gli attesi sono istanti ASSOLUTI (Date.UTC / stringhe con offset esplicito): se gli helper
// usassero il fuso del processo invece di quello passato, questi test fallirebbero appena la
// suite gira con TZ diverso da Roma (vedi la verifica TZ=America/New_York).
const timeZone = "Europe/Rome";

describe("dateTimeFromParts", () => {
  it("converte l'ora di parete col fuso del campo, non con quello del processo", () => {
    // 3 luglio 2026: Roma e' in ora legale (UTC+2).
    expect(dateTimeFromParts("2026-07-03", "10:00", timeZone).getTime()).toBe(
      Date.UTC(2026, 6, 3, 8, 0),
    );
    // 15 gennaio 2026: ora solare (UTC+1). Cosi' copriamo entrambi gli offset.
    expect(dateTimeFromParts("2026-01-15", "10:00", timeZone).getTime()).toBe(
      Date.UTC(2026, 0, 15, 9, 0),
    );
  });

  it('normalizza "24:00" nella mezzanotte del giorno dopo (parita\' col vecchio parse ISO)', () => {
    // Fine dell'ultimo blocco admin (23:45-24:00): deve coincidere con le 00:00 del giorno dopo.
    expect(dateTimeFromParts("2026-07-03", "24:00", timeZone).getTime()).toBe(
      dateTimeFromParts("2026-07-04", "00:00", timeZone).getTime(),
    );
    // Il rollover attraversa anche fine mese e fine anno senza passare dal fuso del dispositivo.
    expect(dateTimeFromParts("2026-07-31", "24:00", timeZone).getTime()).toBe(
      dateTimeFromParts("2026-08-01", "00:00", timeZone).getTime(),
    );
    expect(dateTimeFromParts("2026-12-31", "24:00", timeZone).getTime()).toBe(
      dateTimeFromParts("2027-01-01", "00:00", timeZone).getTime(),
    );
  });
});

describe("chiavi giorno/ora nel fuso del campo", () => {
  it("legge giorno e ora di parete anche a cavallo della mezzanotte", () => {
    // 22:30Z del 3 luglio = 00:30 del 4 luglio a Roma: il giorno "del campo" e' gia' il 4.
    const lateEvening = new Date(Date.UTC(2026, 6, 3, 22, 30));

    expect(dayKeyInTimeZone(lateEvening, timeZone)).toBe("2026-07-04");
    expect(timeKeyInTimeZone(lateEvening, timeZone)).toBe("00:30");
  });

  it("fa il giro completo con dateTimeFromParts", () => {
    const instant = dateTimeFromParts("2026-07-03", "18:15", timeZone);

    expect(dayKeyInTimeZone(instant, timeZone)).toBe("2026-07-03");
    expect(timeKeyInTimeZone(instant, timeZone)).toBe("18:15");
  });
});

describe("formattatori con fuso esplicito", () => {
  // Slot di parete 10:00 del 3 luglio 2026 (venerdi'), espresso come istante assoluto.
  const start = new Date(Date.UTC(2026, 6, 3, 8, 0));

  it("localTime mostra l'ora di parete del campo", () => {
    expect(localTime(start, timeZone)).toBe("10:00");
  });

  it("localDay e localDateTime restano sul giorno di parete", () => {
    // Niente confronto sull'intera stringa: separatori e abbreviazioni dipendono dalla versione
    // ICU. Contano giorno, mese e (per localDateTime) l'ora di parete.
    expect(localDay(start, timeZone)).toContain("03");
    expect(localDay(start, timeZone)).toContain("lug");
    expect(localDateTime(start, timeZone)).toContain("03");
    expect(localDateTime(start, timeZone)).toContain("10:00");
  });
});
