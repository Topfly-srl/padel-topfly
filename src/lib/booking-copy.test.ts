import { describe, expect, it } from "vitest";
import { publicOrganizerLabel } from "@/lib/booking-copy";

describe("publicOrganizerLabel", () => {
  it("abbrevia il cognome a un'iniziale col punto", () => {
    expect(publicOrganizerLabel("Antony Buffone")).toBe("Antony B.");
    expect(publicOrganizerLabel("Mario Rossi")).toBe("Mario R.");
  });

  it("lascia intatto un nome singolo", () => {
    expect(publicOrganizerLabel("Cher")).toBe("Cher");
  });

  it("tiene i nomi intermedi e abbrevia solo l'ultimo token", () => {
    expect(publicOrganizerLabel("Anna Maria Rossi")).toBe("Anna Maria R.");
  });

  it("gestisce spazi multipli e bordi", () => {
    expect(publicOrganizerLabel("  Mario   Rossi  ")).toBe("Mario R.");
    expect(publicOrganizerLabel("  Cher  ")).toBe("Cher");
    expect(publicOrganizerLabel("")).toBe("");
  });
});
