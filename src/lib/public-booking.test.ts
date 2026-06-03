import { beforeEach, describe, expect, it } from "vitest";
import {
  demoCancelBooking,
  demoCreateBooking,
  demoLookupBookings,
  demoReset,
} from "@/lib/demo-store";

function futureSlot(dayOffset: number, hour: number) {
  const start = new Date();
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start, end };
}

describe("public booking flow", () => {
  beforeEach(() => {
    demoReset();
  });

  it("crea una prenotazione pubblica con token senza esporre l'email", async () => {
    const slot = futureSlot(1, 10);
    const booking = await demoCreateBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "Mario.Rossi@example.com",
      baseUrl: "https://padel.example.com",
    });

    expect(booking.organizerName).toBe("Mario Rossi");
    expect(booking.manageToken).toBeTruthy();
    expect(booking.manageUrl).toContain(`/manage/${booking.id}?token=`);
    expect("organizerEmail" in booking).toBe(false);
  });

  it("recupera solo le prenotazioni col token corretto", async () => {
    const slot = futureSlot(1, 11);
    const booking = await demoCreateBooking({
      ...slot,
      organizerName: "Laura Bianchi",
      organizerEmail: "laura@example.com",
    });

    await expect(demoLookupBookings(["token-sbagliato"])).resolves.toEqual([]);
    const found = await demoLookupBookings([booking.manageToken!]);

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(booking.id);
  });

  it("limita a 2 prenotazioni future per email", async () => {
    await demoCreateBooking({
      ...futureSlot(1, 12),
      organizerName: "Giulia Verdi",
      organizerEmail: "giulia@example.com",
    });
    await demoCreateBooking({
      ...futureSlot(2, 12),
      organizerName: "Giulia Verdi",
      organizerEmail: "GIULIA@example.com",
    });

    await expect(
      demoCreateBooking({
        ...futureSlot(3, 12),
        organizerName: "Giulia Verdi",
        organizerEmail: "giulia@example.com",
      }),
    ).rejects.toThrow("Hai gia' 2 prenotazioni future attive.");
  });

  it("cancella una prenotazione con token valido", async () => {
    const booking = await demoCreateBooking({
      ...futureSlot(1, 13),
      organizerName: "Paolo Neri",
      organizerEmail: "paolo@example.com",
    });

    const canceled = await demoCancelBooking(
      { manageToken: booking.manageToken },
      booking.id,
    );

    expect(canceled.status).toBe("CANCELED");
  });
});
