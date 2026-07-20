import { describe, expect, it } from "vitest";
import { auditActionLabel, publicOrganizerLabel } from "@/lib/booking-copy";
import { auditActions } from "@/lib/types";

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

describe("auditActionLabel", () => {
  it("da' un'etichetta leggibile a ogni azione offerta dal filtro", () => {
    for (const action of auditActions) {
      const label = auditActionLabel(action);
      expect(label).not.toBe(action);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("ripiega sul codice grezzo per un'azione non mappata", () => {
    expect(auditActionLabel("BOOKING_SIGNATURE_REMINDER_SENT")).toBe("BOOKING_SIGNATURE_REMINDER_SENT");
  });
});
