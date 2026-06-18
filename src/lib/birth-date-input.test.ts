import { describe, expect, it } from "vitest";
import { birthDateInputToIsoDate, formatBirthDateInput } from "@/lib/birth-date-input";
import { isIsoDateOnly, isoDateOnlyToDate } from "@/lib/date-only";

describe("birth date input", () => {
  it("formatta cifre digitate in gg/mm/aaaa", () => {
    expect(formatBirthDateInput("17061990")).toBe("17/06/1990");
    expect(formatBirthDateInput("17/06/1990")).toBe("17/06/1990");
    expect(formatBirthDateInput("1990-06-17")).toBe("17/06/1990");
  });

  it("converte solo date reali in ISO", () => {
    expect(birthDateInputToIsoDate("17/06/1990")).toBe("1990-06-17");
    expect(birthDateInputToIsoDate("31/02/1990")).toBeNull();
    expect(birthDateInputToIsoDate("17/6/1990")).toBeNull();
  });

  it("accetta lato API solo date yyyy-mm-dd reali", () => {
    expect(isIsoDateOnly("1990-06-17")).toBe(true);
    expect(isoDateOnlyToDate("1990-06-17").toISOString()).toBe("1990-06-17T00:00:00.000Z");
    expect(isIsoDateOnly("1990-02-31")).toBe(false);
    expect(isIsoDateOnly("17/06/1990")).toBe(false);
  });
});
