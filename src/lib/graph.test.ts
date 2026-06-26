import type { Booking } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

function bookingFixture(overrides: Partial<Booking> = {}): Booking {
  const now = new Date("2026-06-03T10:00:00.000Z");

  return {
    id: "booking_1",
    start: new Date("2026-06-04T16:00:00.000Z"),
    end: new Date("2026-06-04T17:00:00.000Z"),
    status: "CONFIRMED",
    organizerName: "Mario Rossi",
    organizerEmail: "mario@topfly.it",
    manageTokenHash: null,
    manageTokenExpiresAt: null,
    outlookEventId: null,
    outlookSyncStatus: "PENDING",
    outlookSyncError: null,
    playerCount: 4,
    waiverRevision: 1,
    signatureDeadlineAt: null,
    signatureReminderSentAt: null,
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    guestWaiverTokenHash: null,
    guestWaiverTokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    organizerId: null,
    ...overrides,
  };
}

describe("Microsoft Graph sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("mantiene il link gestione quando aggiorna una booking senza evento esistente", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ id: "event_1" }), { status: 201 });
      }),
    );

    const { updateOutlookEvent } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_1",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CONFIRMED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: null,
      outlookSyncStatus: "PENDING",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });
    const manageUrl = "https://padel.topfly.it/manage/booking_1?token=abc";

    const result = await updateOutlookEvent(
      booking,
      { email: booking.organizerEmail, name: booking.organizerName },
      manageUrl,
    );

    const eventCall = calls.find((call) => call.url.includes("/calendar/events"));
    expect(result).toEqual({ status: "SYNCED", eventId: "event_1" });
    expect(eventCall).toBeDefined();

    const eventPayload = JSON.parse(eventCall!.body!);
    expect(eventPayload.subject).toBe("Padel TOPFLY - Campo prenotato");
    expect(eventPayload.body.content).toContain("Prenotazione campo confermata");
    expect(eventPayload.body.content).toContain("18:00 - 19:00");
    expect(eventPayload.body.content).toContain("Gestisci prenotazione");
    expect(eventPayload.body.content).toContain(manageUrl);
  });

  it("mantiene start e fine corretti per durate non standard nell'evento Outlook", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ id: `event_${calls.length}` }), { status: 201 });
      }),
    );

    const { createOutlookEvent } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");

    for (const minutes of [45, 75, 105]) {
      const start = new Date("2026-06-07T17:30:00.000Z");
      const end = new Date(start.getTime() + minutes * 60_000);
      const booking = bookingFixture({
        id: `booking_${minutes}`,
        start,
        end,
        status: "CONFIRMED",
        organizerName: "Mario Rossi",
        organizerEmail: "mario@topfly.it",
        manageTokenHash: null,
        manageTokenExpiresAt: null,
        outlookEventId: null,
        outlookSyncStatus: "PENDING",
        outlookSyncError: null,
        playerCount: 4,
        waiverRevision: 1,
        guestWaiverTokenHash: null,
        guestWaiverTokenExpiresAt: null,
        createdAt: now,
        updatedAt: now,
        organizerId: null,
      });

      await expect(
        createOutlookEvent(
          booking,
          { email: booking.organizerEmail, name: booking.organizerName },
          `https://padel.topfly.it/manage/${booking.id}?token=abc`,
        ),
      ).resolves.toMatchObject({ status: "SYNCED" });
    }

    const eventCalls = calls.filter((call) => call.url.includes("/calendar/events"));
    expect(eventCalls).toHaveLength(3);

    for (const [index, minutes] of [45, 75, 105].entries()) {
      const payload = JSON.parse(eventCalls[index].body!);
      const payloadDuration = Math.round(
        (Date.parse(payload.end.dateTime) - Date.parse(payload.start.dateTime)) / 60_000,
      );

      expect(payloadDuration).toBe(minutes);
      expect(payload.body.content).toContain(`${minutes} min`);
    }
  });

  it("cancella l'evento Outlook senza inviare update duplicati", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { deleteOutlookEvent } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_1",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CANCELED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "PENDING",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });

    const result = await deleteOutlookEvent(booking);
    const patchCall = calls.find(
      (call) => call.url.includes("/events/event_1") && call.method === "PATCH",
    );
    const sendMailCall = calls.find((call) => call.url.includes("/sendMail"));
    const cancelCall = calls.find((call) => call.url.includes("/events/event_1/cancel"));

    expect(result).toEqual({ status: "SYNCED", eventId: "event_1" });
    expect(patchCall).toBeUndefined();
    expect(sendMailCall).toBeUndefined();
    expect(cancelCall).toBeDefined();

    const cancelPayload = JSON.parse(cancelCall!.body!);
    expect(cancelPayload.comment).toContain("la tua prenotazione del campo Padel TOPFLY");
    expect(cancelPayload.comment).toContain("Il campo torna disponibile per gli altri colleghi.");
    expect(cancelPayload.comment).not.toContain("Durata:");
  });

  it("segna sync fallito se la cancellazione Outlook fallisce", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ error: { code: "ErrorItemNotFound" } }), {
          status: 404,
        });
      }),
    );

    const { deleteOutlookEvent } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_1",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CANCELED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "PENDING",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });

    const result = await deleteOutlookEvent(booking);
    const cancelCall = calls.find((call) => call.url.includes("/events/event_1/cancel"));

    expect(result.status).toBe("FAILED");
    expect(result.eventId).toBe("event_1");
    expect(result.error).toContain("Graph 404");
    expect(cancelCall).toBeDefined();
  });

  it("invia lo scarico responsabilita' alla mailbox configurata con PDF allegato", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");
    vi.stubEnv("APP_WAIVER_RECIPIENT_EMAIL", "padel@topflysolutions.com");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendWaiverEmail } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_1",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CONFIRMED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "SYNCED",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });

    const result = await sendWaiverEmail({
      booking,
      signerName: "Mario Rossi",
      signerEmail: "mario@topfly.it",
      signedAt: now,
      pdfBytes: new Uint8Array([37, 80, 68, 70]),
      filename: "scarico.pdf",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("padel@topflysolutions.com");
    expect(payload.message.attachments[0].name).toBe("scarico.pdf");
    expect(payload.message.attachments[0].contentType).toBe("application/pdf");
    expect(payload.message.attachments[0].contentBytes).toBe("JVBERg==");
  });

  it("invia conferma ospite con allegato calendario e link rinuncia", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendGuestWaiverConfirmationEmail } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_guest",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CONFIRMED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "SYNCED",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });

    const result = await sendGuestWaiverConfirmationEmail({
      booking,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
      signedAt: now,
      cancelUrl: "https://padel.topflysolutions.com/waiver/cancel/waiver_1?token=abc",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.subject).toBe("Padel TOPFLY - Firma accesso campo confermata");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Rinuncia al posto");
    expect(payload.message.body.content).toContain("/waiver/cancel/waiver_1");
    expect(payload.message.attachments[0].name).toBe("padel-topfly.ics");
    expect(payload.message.attachments[0].contentType).toBe("text/calendar");
  });

  it("invia al referente la mail di prenotazione provvisoria con link firma ospiti", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendOrganizerPendingSignatureEmail } = await import("@/lib/graph");
    const booking = bookingFixture({
      status: "PENDING_SIGNATURES",
      signatureDeadlineAt: new Date("2026-06-04T12:00:00.000Z"),
    });

    const result = await sendOrganizerPendingSignatureEmail({
      booking,
      signedCount: 1,
      manageUrl: "https://padel.topfly.it/manage/booking_1?token=manage",
      guestWaiverUrl: "https://padel.topfly.it/waiver/booking_1?token=guest",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.subject).toBe("Padel TOPFLY - Prenotazione in attesa firme");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(payload.message.body.content).toContain("Prenotazione provvisoria");
    expect(payload.message.body.content).toContain("Link firma ospiti");
    expect(payload.message.body.content).toContain("/waiver/booking_1?token=guest");
  });

  it("avvisa un ospite quando la prenotazione viene modificata e include il nuovo link firma", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendGuestBookingUpdatedEmail } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const previousBooking = bookingFixture({
      id: "booking_guest",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CONFIRMED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "SYNCED",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });
    const booking = bookingFixture({
      ...previousBooking,
      start: new Date("2026-06-04T18:00:00.000Z"),
      end: new Date("2026-06-04T19:00:00.000Z"),
      waiverRevision: 2,
    });

    const result = await sendGuestBookingUpdatedEmail({
      previousBooking,
      booking,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
      guestWaiverUrl: "https://padel.topflysolutions.com/w/booking_guest/token123",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.subject).toBe("Padel TOPFLY - Prenotazione modificata");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Prenotazione modificata");
    expect(payload.message.body.content).toContain("18:00 - 19:00");
    expect(payload.message.body.content).toContain("Firma per il nuovo orario");
    expect(payload.message.body.content).toContain("/w/booking_guest/token123");
  });

  it("avvisa un ospite quando la prenotazione viene cancellata con allegato calendario cancel", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString(), method: init?.method });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendGuestBookingCanceledEmail } = await import("@/lib/graph");
    const now = new Date("2026-06-03T10:00:00.000Z");
    const booking = bookingFixture({
      id: "booking_guest",
      start: new Date("2026-06-04T16:00:00.000Z"),
      end: new Date("2026-06-04T17:00:00.000Z"),
      status: "CANCELED",
      organizerName: "Mario Rossi",
      organizerEmail: "mario@topfly.it",
      manageTokenHash: null,
      manageTokenExpiresAt: null,
      outlookEventId: "event_1",
      outlookSyncStatus: "SYNCED",
      outlookSyncError: null,
      playerCount: 4,
      waiverRevision: 1,
      guestWaiverTokenHash: null,
      guestWaiverTokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      organizerId: null,
    });

    const result = await sendGuestBookingCanceledEmail({
      booking,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.subject).toBe("Padel TOPFLY - Prenotazione cancellata");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Prenotazione cancellata");
    expect(payload.message.attachments[0].name).toBe("padel-topfly-cancellazione.ics");
    expect(payload.message.attachments[0].contentType).toBe("text/calendar; method=CANCEL");

    const ics = Buffer.from(payload.message.attachments[0].contentBytes, "base64").toString("utf8");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("UID:booking_guest-laura@example.com@padel.topflysolutions.com");
  });
});
