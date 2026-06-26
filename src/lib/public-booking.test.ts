import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  demoCancelBooking,
  demoCreateAdminBlock,
  demoCreateBooking,
  demoGetAdminAudit,
  demoGetAvailability,
  demoLookupBookings,
  demoReset,
  demoUpdateBooking,
} from "@/lib/demo-store";
import type { CurrentUser } from "@/lib/types";

const adminUser: CurrentUser = {
  id: "admin_1",
  email: "admin@topfly.it",
  name: "Admin",
  role: "ADMIN",
};
const signatureImageDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function futureSlot(dayOffset: number, hour: number, minute = 0) {
  const start = new Date();
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour, minute, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start, end };
}

function createDemoBooking(input: Parameters<typeof demoCreateBooking>[0]) {
  return demoCreateBooking({
    ...input,
    playerCount: input.playerCount ?? 4,
    waiver: {
      signerName: input.organizerName,
      signerEmail: input.organizerEmail,
      birthDate: new Date("1990-01-01T00:00:00.000Z"),
      birthPlace: "Pretoro",
      isAdultConfirmed: true,
      privacyAccepted: true,
      regulationAccepted: true,
      liabilityAccepted: true,
      specificApprovalAccepted: true,
      signatureText: input.organizerName,
      signatureImageDataUrl,
    },
  });
}

describe("public booking flow", () => {
  beforeEach(() => {
    demoReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("crea una prenotazione pubblica con token senza esporre l'email", async () => {
    const slot = futureSlot(1, 10);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "Mario.Rossi@example.com",
      baseUrl: "https://padel.example.com",
    });

    expect(booking.organizerName).toBe("Mario Rossi");
    expect(booking.status).toBe("PENDING_SIGNATURES");
    expect(booking.signatureDeadlineAt).toBeTruthy();
    expect(booking.manageToken).toBeTruthy();
    expect(booking.manageUrl).toContain(`/manage/${booking.id}?token=`);
    expect("organizerEmail" in booking).toBe(false);
  });

  it("non espone email nella availability pubblica", async () => {
    const slot = futureSlot(1, 10);
    await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
    });

    const availability = await demoGetAvailability(dateKey(slot.start));

    expect(availability.bookings).toHaveLength(1);
    expect(availability.bookings[0].organizerName).toBe("Mario Rossi");
    expect(availability.bookings[0].status).toBe("PENDING_SIGNATURES");
    expect("organizerEmail" in availability.bookings[0]).toBe(false);
  });

  it("annulla automaticamente una pending incompleta dopo la deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
    });

    vi.setSystemTime(new Date(new Date(booking.signatureDeadlineAt!).getTime() + 60_000));
    const availability = await demoGetAvailability(dateKey(slot.start));
    const [found] = await demoLookupBookings([booking.manageToken!]);

    expect(availability.bookings).toHaveLength(0);
    expect(found.status).toBe("CANCELED");
    expect(found.autoCanceledAt).toBeTruthy();
  });

  it("manda un solo reminder demo prima della deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
    });

    vi.setSystemTime(new Date(new Date(booking.signatureDeadlineAt!).getTime() - 30 * 60_000));
    await demoGetAvailability(dateKey(slot.start));
    await demoGetAvailability(dateKey(slot.start));

    const reminders = (await demoGetAdminAudit()).filter((item) => item.action === "BOOKING_SIGNATURE_REMINDER_SENT");
    expect(reminders).toHaveLength(1);
  });

  it("recupera solo le prenotazioni col token corretto", async () => {
    const slot = futureSlot(1, 11);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Laura Bianchi",
      organizerEmail: "laura@example.com",
    });

    await expect(demoLookupBookings(["token-sbagliato"])).resolves.toEqual([]);
    const found = await demoLookupBookings([booking.manageToken!]);

    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(booking.id);
  });

  it("non recupera prenotazioni con token scaduto", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));

    const slot = futureSlot(1, 15);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Laura Bianchi",
      organizerEmail: "laura@example.com",
    });

    vi.setSystemTime(new Date(slot.end.getTime() + 25 * 60 * 60_000));

    await expect(demoLookupBookings([booking.manageToken!])).resolves.toEqual([]);
  });

  it("modifica una prenotazione con token valido", async () => {
    const booking = await createDemoBooking({
      ...futureSlot(1, 14),
      organizerName: "Paolo Neri",
      organizerEmail: "paolo@example.com",
    });
    const next = futureSlot(1, 16);

    const updated = await demoUpdateBooking(
      { manageToken: booking.manageToken },
      booking.id,
      next,
    );

    expect(updated.start).toBe(next.start.toISOString());
    expect(updated.end).toBe(next.end.toISOString());
    expect(updated.status).toBe("PENDING_SIGNATURES");
    expect(updated.waiverSignedCount).toBe(0);
  });

  it("conferma una prenotazione modificata a un giocatore se ha gia' una firma attiva", async () => {
    const booking = await createDemoBooking({
      ...futureSlot(1, 14),
      organizerName: "Paolo Neri",
      organizerEmail: "paolo@example.com",
    });

    const updated = await demoUpdateBooking(
      { manageToken: booking.manageToken },
      booking.id,
      { playerCount: 1 },
    );

    expect(updated.status).toBe("CONFIRMED");
    expect(updated.playerCount).toBe(1);
    expect(updated.waiverSignedCount).toBe(1);
    expect(updated.signatureConfirmedAt).toBeTruthy();
  });

  it("rifiuta modifiche con token errato", async () => {
    const booking = await createDemoBooking({
      ...futureSlot(1, 15),
      organizerName: "Paolo Neri",
      organizerEmail: "paolo@example.com",
    });

    await expect(
      demoUpdateBooking({ manageToken: "token-sbagliato" }, booking.id, futureSlot(1, 17)),
    ).rejects.toThrow("Link di gestione non valido o scaduto.");
  });

  it("limita a 2 prenotazioni future per email", async () => {
    await createDemoBooking({
      ...futureSlot(1, 12),
      organizerName: "Giulia Verdi",
      organizerEmail: "giulia@example.com",
    });
    await createDemoBooking({
      ...futureSlot(2, 12),
      organizerName: "Giulia Verdi",
      organizerEmail: "GIULIA@example.com",
    });

    await expect(
      createDemoBooking({
        ...futureSlot(3, 12),
        organizerName: "Giulia Verdi",
        organizerEmail: "giulia@example.com",
      }),
    ).rejects.toThrow("Hai gia' 2 prenotazioni future attive.");
  });

  it("cancella una prenotazione con token valido", async () => {
    const booking = await createDemoBooking({
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

  it("rifiuta blocchi admin non allineati a 15 minuti anche in demo", async () => {
    const start = futureSlot(1, 9, 5).start;
    const end = new Date(start.getTime() + 60 * 60_000);

    await expect(
      demoCreateAdminBlock(adminUser, {
        start,
        end,
        reason: "Manutenzione",
      }),
    ).rejects.toThrow("Il blocco deve usare step da 15 minuti.");
  });
});
