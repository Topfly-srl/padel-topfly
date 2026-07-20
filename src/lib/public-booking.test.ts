import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  demoCancelBooking,
  demoCancelGuestWaiverSignature,
  demoCreateAdminBlock,
  demoCreateBooking,
  demoGetAdminAudit,
  demoGetGuestWaiverCancelContext,
  demoGetAvailability,
  demoLookupBookings,
  demoReset,
  demoSignGuestWaiver,
  demoUpdateBooking,
} from "@/lib/demo-store";
import { signatureReplacementDeadlineAt } from "@/lib/signature-workflow";
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

  it("non espone email ne' cognome intero nella availability pubblica", async () => {
    const slot = futureSlot(1, 10);
    await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
    });

    const availability = await demoGetAvailability(dateKey(slot.start));

    expect(availability.bookings).toHaveLength(1);
    expect(availability.bookings[0].organizerName).toBe("Mario R.");
    expect(availability.bookings[0].organizerName).not.toBe("Mario Rossi");
    expect(availability.bookings[0].status).toBe("PENDING_SIGNATURES");
    expect("organizerEmail" in availability.bookings[0]).toBe(false);
  });

  it("mostra il nome intero nella availability quando la legge un admin", async () => {
    const slot = futureSlot(1, 10);
    await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
    });

    const availability = await demoGetAvailability(dateKey(slot.start), adminUser);

    expect(availability.bookings).toHaveLength(1);
    expect(availability.bookings[0].organizerName).toBe("Mario Rossi");
  });

  it("il lookup del proprietario mostra il nome completo", async () => {
    const slot = futureSlot(1, 10);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
    });

    const [found] = await demoLookupBookings([booking.manageToken!]);

    expect(found.organizerName).toBe("Mario Rossi");
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

  it("chiude comunque la pending scaduta di una partita gia' iniziata", async () => {
    // Le pending last minute hanno la scadenza firme che coincide con l'inizio: se la chiusura
    // pretendesse "scaduta E non ancora iniziata" non scatterebbe mai e resterebbero appese per
    // sempre, con il link firma vivo fino a end+24h.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
    });

    vi.setSystemTime(new Date(slot.start.getTime() + 60 * 60_000));
    await demoGetAvailability(dateKey(slot.start));
    const [found] = await demoLookupBookings([booking.manageToken!]);

    expect(found.status).toBe("CANCELED");
  });

  it("non lascia firmare una pending la cui scadenza e' gia' passata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
      baseUrl: "https://padel.example.com",
    });
    const guestToken = new URL(booking.guestWaiverUrl!).searchParams.get("token");

    vi.setSystemTime(new Date(new Date(booking.signatureDeadlineAt!).getTime() + 60_000));

    await expect(
      demoSignGuestWaiver(
        booking.id,
        guestToken,
        {
          signerName: "Luca Bianchi",
          signerEmail: "luca@example.com",
          birthDate: new Date("1990-01-01T00:00:00.000Z"),
          birthPlace: "Pretoro",
          isAdultConfirmed: true,
          privacyAccepted: true,
          regulationAccepted: true,
          liabilityAccepted: true,
          specificApprovalAccepted: true,
          signatureText: "Luca Bianchi",
          signatureImageDataUrl,
        },
        {},
      ),
    ).rejects.toThrow();
  });

  it("percorre la rinuncia ospite demo end-to-end e la seconda e' idempotente", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 2,
      baseUrl: "https://padel.example.com",
    });
    const guestToken = new URL(booking.guestWaiverUrl!).searchParams.get("token");

    const signed = await demoSignGuestWaiver(
      booking.id,
      guestToken,
      {
        signerName: "Luca Bianchi",
        signerEmail: "luca@example.com",
        birthDate: new Date("1990-01-01T00:00:00.000Z"),
        birthPlace: "Pretoro",
        isAdultConfirmed: true,
        privacyAccepted: true,
        regulationAccepted: true,
        liabilityAccepted: true,
        specificApprovalAccepted: true,
        signatureText: "Luca Bianchi",
        signatureImageDataUrl,
      },
      {},
      "https://padel.example.com",
    );

    expect(signed.booking.status).toBe("CONFIRMED");
    expect(signed.guestWaiverCancelUrl).toBeTruthy();

    const cancelUrl = new URL(signed.guestWaiverCancelUrl!);
    const signatureId = cancelUrl.pathname.split("/").pop()!;
    const cancelToken = cancelUrl.searchParams.get("token");

    const canceled = await demoCancelGuestWaiverSignature(signatureId, cancelToken);
    expect(canceled.signature.status).toBe("CANCELED");
    expect(canceled.booking.status).toBe("PENDING_SIGNATURES");
    expect(canceled.booking.waiverSignedCount).toBe(1);

    const [reverted] = await demoLookupBookings([booking.manageToken!]);
    expect(reverted.status).toBe("PENDING_SIGNATURES");
    expect(reverted.signatureDeadlineAt).toBe(
      signatureReplacementDeadlineAt(slot.start).toISOString(),
    );

    const again = await demoCancelGuestWaiverSignature(signatureId, cancelToken);
    expect(again.signature.status).toBe("CANCELED");
    expect(again.booking.status).toBe("PENDING_SIGNATURES");
    expect(again.booking.waiverSignedCount).toBe(1);
  });

  it("espone canCancel nel contesto rinuncia secondo firma, inizio partita e stato", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 2,
      baseUrl: "https://padel.example.com",
    });
    const guestToken = new URL(booking.guestWaiverUrl!).searchParams.get("token");

    const signed = await demoSignGuestWaiver(
      booking.id,
      guestToken,
      {
        signerName: "Luca Bianchi",
        signerEmail: "luca@example.com",
        birthDate: new Date("1990-01-01T00:00:00.000Z"),
        birthPlace: "Pretoro",
        isAdultConfirmed: true,
        privacyAccepted: true,
        regulationAccepted: true,
        liabilityAccepted: true,
        specificApprovalAccepted: true,
        signatureText: "Luca Bianchi",
        signatureImageDataUrl,
      },
      {},
      "https://padel.example.com",
    );

    expect(signed.booking.status).toBe("CONFIRMED");
    const cancelUrl = new URL(signed.guestWaiverCancelUrl!);
    const signatureId = cancelUrl.pathname.split("/").pop()!;
    const cancelToken = cancelUrl.searchParams.get("token");

    // Firma attiva, partita futura, prenotazione viva: si puo' ancora rinunciare.
    const before = await demoGetGuestWaiverCancelContext(signatureId, cancelToken);
    expect(before.canCancel).toBe(true);

    // Partita gia' iniziata: il server rifiuterebbe con 409, quindi canCancel deve spegnersi.
    vi.setSystemTime(new Date(slot.start.getTime() + 60_000));
    const started = await demoGetGuestWaiverCancelContext(signatureId, cancelToken);
    expect(started.signature.status).toBe("ACTIVE");
    expect(started.canCancel).toBe(false);

    // Firma gia' rinunciata: niente piu' rinuncia possibile.
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const canceled = await demoCancelGuestWaiverSignature(signatureId, cancelToken);
    expect(canceled.signature.status).toBe("CANCELED");
    expect(canceled.canCancel).toBe(false);
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

  it("scrive la riga di sintesi SIGNATURE_DEADLINES_RUN quando la pulizia demo ha attivita'", async () => {
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
    await demoGetAvailability(dateKey(slot.start));

    const actions = (await demoGetAdminAudit()).map((item) => item.action);
    expect(actions).toContain("BOOKING_AUTO_CANCELED_SIGNATURES");
    expect(actions).toContain("SIGNATURE_DEADLINES_RUN");
  });

  it("non scrive SIGNATURE_DEADLINES_RUN quando la pulizia demo non fa nulla", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(2, 12);
    await createDemoBooking({
      ...slot,
      organizerName: "Mario Rossi",
      organizerEmail: "mario@example.com",
      playerCount: 4,
    });

    await demoGetAvailability(dateKey(slot.start));

    const actions = (await demoGetAdminAudit()).map((item) => item.action);
    expect(actions).not.toContain("SIGNATURE_DEADLINES_RUN");
  });

  it("rifiuta lo spostamento demo di una partita gia' iniziata da un non-admin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T10:00:00.000Z"));
    const slot = futureSlot(1, 14);
    const booking = await createDemoBooking({
      ...slot,
      organizerName: "Paolo Neri",
      organizerEmail: "paolo@example.com",
      playerCount: 1,
    });
    expect(booking.status).toBe("CONFIRMED");

    vi.setSystemTime(new Date(slot.start.getTime() + 30 * 60_000));
    const next = futureSlot(3, 16);

    await expect(
      demoUpdateBooking({ manageToken: booking.manageToken }, booking.id, next),
    ).rejects.toThrow("La partita è già iniziata");

    // L'admin resta autorizzato a riprogrammarla.
    const moved = await demoUpdateBooking({ adminUser }, booking.id, next);
    expect(moved.start).toBe(next.start.toISOString());
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
    ).rejects.toThrow("Hai già 2 prenotazioni future attive.");
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
