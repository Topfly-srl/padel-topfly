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
    signatureWindowStartedAt: null,
    signatureReminderSentAt: null,
    signatureConfirmedAt: null,
    autoCanceledAt: null,
    cancelReason: null,
    guestWaiverTokenHash: null,
    guestWaiverTokenExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    organizerId: null,
    ...overrides,
  };
}

type SendMailCall = { url: string; body?: string; method?: string };

function stubWaiverGraphEnv() {
  vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
  vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
  vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
  vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");
  vi.stubEnv("APP_WAIVER_RECIPIENT_EMAIL", "padel@topflysolutions.com");
}

// Raccoglie i sendMail e lascia decidere per destinatario quale deve fallire: e' l'unico modo
// di verificare che una leg rotta non trascini l'altra.
function stubWaiverSendMail(failFor?: (recipient: string) => Response | null) {
  const calls: SendMailCall[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();

      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        });
      }

      const body = init?.body?.toString();
      calls.push({ url, body, method: init?.method });

      const recipient = body
        ? JSON.parse(body).message.toRecipients[0].emailAddress.address
        : "";

      return failFor?.(recipient) ?? new Response(null, { status: 202 });
    }),
  );

  return calls;
}

function waiverMailInput(
  overrides: {
    signerCopyEmail?: string;
    signerName?: string;
    legs?: Array<"archive" | "signer">;
  } = {},
) {
  const signedAt = new Date("2026-06-03T10:00:00.000Z");

  return {
    booking: bookingFixture(),
    signerName: "Mario Rossi",
    signerEmail: "mario@topfly.it",
    signedAt,
    pdfBytes: new Uint8Array([37, 80, 68, 70]),
    filename: "scarico.pdf",
    ...overrides,
  };
}

function waiverRecipients(calls: SendMailCall[]) {
  return calls
    .filter((call) => call.url.includes("/sendMail"))
    .map((call) => JSON.parse(call.body!).message.toRecipients[0].emailAddress.address);
}

type RenderedMail = {
  subject: string;
  body: { content: string };
  attachments?: Array<{ name: string; contentBytes?: string }>;
};

// Rende in un colpo solo tutte le email che escono dal progetto. I vincoli del guscio valgono
// per tutte: una regola verificata su nove template e' esattamente il modo in cui ci si dimentica
// del decimo, che poi e' quello che arriva nel momento critico.
async function renderAllMails(): Promise<RenderedMail[]> {
  vi.resetModules();
  stubWaiverGraphEnv();

  const calls = stubWaiverSendMail();
  const graph = await import("@/lib/graph");
  const booking = bookingFixture({
    status: "PENDING_SIGNATURES",
    signatureDeadlineAt: new Date("2026-06-04T12:00:00.000Z"),
    // Sentinella: la causale d'annullamento e' l'unico campo a testo libero della prenotazione e
    // NON deve mai finire in un'email (potrebbe contenere un nome). Presente su tutto il corpus,
    // cosi' se un template la reintroducesse il guard qui sotto scatterebbe.
    cancelReason: "CAUSALE-SENTINELLA-Mario-Verdi",
  });
  const signedAt = new Date("2026-06-03T10:00:00.000Z");
  const waiverPdf = { pdfBytes: new Uint8Array([37, 80, 68, 70]), filename: "scarico.pdf" };
  const guest = { signerName: "Laura Bianchi", signerEmail: "laura@example.com" };
  const guestWaiverUrl = "https://padel.topflysolutions.com/w/booking_1/token123";

  await graph.sendWaiverEmail({ booking, ...guest, signedAt, ...waiverPdf, legs: ["archive"] });
  await graph.sendGuestWaiverConfirmationEmail({
    booking,
    ...guest,
    signedAt,
    cancelUrl: "https://padel.topflysolutions.com/waiver/cancel/waiver_1?token=abc",
    ...waiverPdf,
  });
  await graph.sendGuestBookingUpdatedEmail({
    previousBooking: booking,
    booking,
    ...guest,
    guestWaiverUrl,
  });
  await graph.sendGuestBookingCanceledEmail({ booking, ...guest });
  await graph.sendGuestWithdrawalConfirmationEmail({ booking, ...guest });
  await graph.sendOrganizerPendingSignatureEmail({
    booking,
    signedCount: 1,
    manageUrl: "https://padel.topflysolutions.com/manage/booking_1?token=manage",
    guestWaiverUrl,
    ...waiverPdf,
  });
  await graph.sendOrganizerGuestWithdrewEmail({
    booking,
    signerName: "Luca Bianchi",
    signedCount: 3,
  });
  await graph.sendOrganizerSignatureReminderEmail({ booking, signedCount: 1 });
  await graph.sendOrganizerAutoCanceledEmail({ booking, signedCount: 1 });
  await graph.sendOrganizerBookingCanceledEmail({ booking, actor: "organizer" });
  await graph.sendOrganizerBookingCanceledEmail({ booking, actor: "admin" });

  return calls.map((call) => JSON.parse(call.body!).message as RenderedMail);
}

// L'invito di calendario non passa da /sendMail, quindi restava fuori dal corpus: i guard che
// dicono "ogni email" lo esentavano proprio perche' e' l'unico costruito da un'altra porta. Esce
// dalla stessa fabbrica e arriva nella stessa casella: i vincoli del guscio valgono anche per
// lui. Reso in tutte e due le forme, perche' il ramo senza manageUrl e' IL percorso di conferma
// (signature-workflow non ha il token in chiaro) ed e' quello che nessuno guardava.
async function renderOutlookEvents(): Promise<RenderedMail[]> {
  vi.resetModules();
  stubWaiverGraphEnv();

  const calls: SendMailCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();

      if (url.includes("login.microsoftonline.com")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        });
      }

      calls.push({ url, body: init?.body?.toString(), method: init?.method });
      return new Response(JSON.stringify({ id: "event_1" }), { status: 201 });
    }),
  );

  const graph = await import("@/lib/graph");
  const booking = bookingFixture();
  const organizer = { email: booking.organizerEmail, name: booking.organizerName };

  await graph.createOutlookEvent(
    booking,
    organizer,
    "https://padel.topflysolutions.com/manage/booking_1?token=manage",
  );
  await graph.createOutlookEvent(booking, organizer);

  return calls.map((call) => JSON.parse(call.body!) as RenderedMail);
}

// Tutto quello che il progetto scrive e spedisce, mail e invito insieme.
async function renderAllMessages(): Promise<RenderedMail[]> {
  return [...(await renderAllMails()), ...(await renderOutlookEvents())];
}

function mailWithSubject(mails: RenderedMail[], fragment: string) {
  const found = mails.filter((mail) => mail.subject.includes(fragment));
  expect(found).toHaveLength(1);
  return found[0];
}

function preheaderOf(mail: RenderedMail) {
  return mail.body.content.match(/mso-hide: all;[^"]*">([^<]*)</)?.[1] ?? "";
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

  it("usa un testo di rimozione diverso quando l'evento torna in attesa di firme", async () => {
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
    const booking = bookingFixture({
      status: "PENDING_SIGNATURES",
      outlookEventId: "event_1",
      outlookSyncStatus: "PENDING",
    });

    const result = await deleteOutlookEvent(booking, "pending");
    const cancelCall = calls.find((call) => call.url.includes("/events/event_1/cancel"));

    expect(result).toEqual({ status: "SYNCED", eventId: "event_1" });
    expect(cancelCall).toBeDefined();
    const comment = JSON.parse(cancelCall!.body!).comment;
    expect(comment).toContain("servono di nuovo le firme");
    expect(comment).toContain("la prenotazione resta valida");
    expect(comment).not.toContain("è stata cancellata");
    expect(comment).not.toContain("Il campo torna disponibile per gli altri colleghi.");
  });

  it("avvisa il referente quando l'amministrazione annulla la sua prenotazione", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendOrganizerBookingCanceledEmail } = await import("@/lib/graph");
    const result = await sendOrganizerBookingCanceledEmail({
      booking: bookingFixture({ status: "CANCELED" }),
      actor: "admin",
    });

    const mailCall = calls.find((call) => call.url.includes("/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(mailCall).toBeDefined();

    const payload = JSON.parse(mailCall!.body!);
    const content = payload.message.body.content.replace(/\s+/g, " ");
    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Prenotazione annullata dall'amministrazione - gio 04 giu, 18:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(content).toContain("annullata dall'amministrazione");
    // Non deve esporre l'identita' personale dell'admin.
    expect(content).not.toContain("stefano");
  });

  it("manda al referente una ricevuta, non un avviso dell'amministrazione, quando annulla lui", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendOrganizerBookingCanceledEmail } = await import("@/lib/graph");
    const result = await sendOrganizerBookingCanceledEmail({
      booking: bookingFixture({ status: "CANCELED" }),
      actor: "organizer",
    });

    const mailCall = calls.find((call) => call.url.includes("/sendMail"));
    expect(result).toEqual({ status: "SENT" });

    const payload = JSON.parse(mailCall!.body!);
    const content = payload.message.body.content.replace(/\s+/g, " ");
    expect(payload.message.subject).toBe("Padel TOPFLY - Prenotazione annullata - gio 04 giu, 18:00");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(content).toContain("hai annullato la prenotazione del gio 04 giu alle 18:00");
    expect(content).toContain("Il campo torna disponibile per gli altri colleghi.");
    // Ha annullato lui: dargli dell'amministrazione lo manderebbe a cercare un colpevole.
    expect(content).not.toContain("amministrazione");
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
      signerCopyEmail: "mario@topfly.it",
    });

    const sendMailCalls = calls.filter((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ archive: { status: "SENT" }, signer: { status: "SENT" } });
    expect(sendMailCalls).toHaveLength(2);

    const payload = JSON.parse(sendMailCalls[0].body!);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("padel@topflysolutions.com");
    expect(payload.message.attachments[0].name).toBe("scarico.pdf");
    expect(payload.message.attachments[0].contentType).toBe("application/pdf");
    expect(payload.message.attachments[0].contentBytes).toBe("JVBERg==");

    const signerPayload = JSON.parse(sendMailCalls[1].body!);
    expect(signerPayload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(signerPayload.message.attachments[0].name).toBe("scarico.pdf");
  });

  it("tiene separati gli esiti delle due copie dello scarico", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail((recipient) =>
      recipient === "mario@topfly.it" ? new Response("mailbox piena", { status: 507 }) : null,
    );

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(waiverMailInput({ signerCopyEmail: "mario@topfly.it" }));

    // La copia al referente non parte, ma l'archivio legale ha ricevuto: gli esiti non si
    // contaminano, cosi' l'area admin sa quale delle due mail manca.
    expect(result.archive).toEqual({ status: "SENT" });
    expect(result.signer?.status).toBe("FAILED");
    expect(waiverRecipients(calls)).toEqual(["padel@topflysolutions.com", "mario@topfly.it"]);
  });

  it("manda comunque la copia al referente quando l'archivio fallisce", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail((recipient) =>
      recipient === "padel@topflysolutions.com" ? new Response("archivio ko", { status: 500 }) : null,
    );

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(waiverMailInput({ signerCopyEmail: "mario@topfly.it" }));

    expect(result.archive?.status).toBe("FAILED");
    expect(result.signer).toEqual({ status: "SENT" });
    expect(waiverRecipients(calls)).toEqual(["padel@topflysolutions.com", "mario@topfly.it"]);
  });

  it("reinvia solo la leg richiesta", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail();

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(
      waiverMailInput({ signerCopyEmail: "mario@topfly.it", legs: ["signer"] }),
    );

    // Nessun esito per l'archivio: la sua colonna non va toccata, non certo riscritta a SENT.
    expect(result.archive).toBeUndefined();
    expect(result.signer).toEqual({ status: "SENT" });
    expect(waiverRecipients(calls)).toEqual(["mario@topfly.it"]);
  });

  it("salta la copia al firmatario per le firme ospite, senza segnalare un errore", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail();

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(waiverMailInput());

    expect(result.archive).toEqual({ status: "SENT" });
    expect(result.signer).toEqual({ status: "SKIPPED" });
    expect(waiverRecipients(calls)).toEqual(["padel@topflysolutions.com"]);
  });

  it("salta la copia al firmatario quando coincide con l'archivio", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail();

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(
      waiverMailInput({ signerCopyEmail: "Padel@TopflySolutions.com" }),
    );

    expect(result.signer).toEqual({ status: "SKIPPED" });
    expect(waiverRecipients(calls)).toEqual(["padel@topflysolutions.com"]);
  });

  it("segna entrambe le copie come saltate quando Graph non e' configurato", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "");
    vi.stubEnv("MS_GRAPH_MAILBOX", "");

    const calls = stubWaiverSendMail();

    const { sendWaiverEmail } = await import("@/lib/graph");
    const result = await sendWaiverEmail(waiverMailInput({ signerCopyEmail: "mario@topfly.it" }));

    // SKIPPED con errore su entrambe: l'invio non e' partito, quindi il reinvio ha senso.
    // Senza errore, invece, SKIPPED vuol dire che non c'era nessuna mail da mandare.
    expect(result.archive).toEqual({ status: "SKIPPED", error: "Microsoft Graph non configurato." });
    expect(result.signer).toEqual({ status: "SKIPPED", error: "Microsoft Graph non configurato." });
    expect(calls).toHaveLength(0);
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
      pdfBytes: new Uint8Array([37, 80, 68, 70]),
      filename: "scarico-laura.pdf",
    });

    const sendMailCall = calls.find((call) => call.url.includes("/users/padel%40topfly.it/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(sendMailCall).toBeDefined();

    const payload = JSON.parse(sendMailCall!.body!);
    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Firma accesso campo confermata - gio 04 giu, 18:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Rinuncia al posto");
    expect(payload.message.body.content).toContain("/waiver/cancel/waiver_1");
    expect(payload.message.body.content).toContain("PDF dello scarico di responsabilità firmato");
    expect(payload.message.body.content).not.toContain("sarà confermata solo quando");
    expect(payload.message.attachments[0].name).toBe("padel-topfly.ics");
    expect(payload.message.attachments[0].contentType).toBe("text/calendar");
    expect(payload.message.attachments[1].name).toBe("scarico-laura.pdf");
    expect(payload.message.attachments[1].contentType).toBe("application/pdf");
    expect(payload.message.attachments[1].contentBytes).toBe("JVBERg==");

    // L'ICS di conferma (METHOD:PUBLISH) porta un allarme: l'ospite non ha il promemoria Outlook
    // del referente, quindi l'avviso un'ora prima glielo da' il VALARM dentro l'evento.
    const ics = Buffer.from(payload.message.attachments[0].contentBytes, "base64").toString("utf8");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("ACTION:DISPLAY");
    expect(ics).toContain("TRIGGER:-PT60M");
    expect(ics).toContain("END:VALARM");
    // Il VALARM sta dentro il VEVENT, non appeso al calendario.
    expect(ics.indexOf("BEGIN:VALARM")).toBeGreaterThan(ics.indexOf("BEGIN:VEVENT"));
    expect(ics.indexOf("END:VALARM")).toBeLessThan(ics.indexOf("END:VEVENT"));
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
    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Prenotazione in attesa firme - gio 04 giu, 18:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(payload.message.body.content).toContain("Prenotazione in attesa firme");
    expect(payload.message.body.content).toContain("Link firma ospiti");
    expect(payload.message.body.content).toContain("/waiver/booking_1?token=guest");

    // Senza PDF (la mail parte anche dopo una modifica, quando le firme sono azzerate) non deve
    // spuntare un allegato vuoto.
    expect(payload.message.attachments).toBeUndefined();
    expect(payload.message.body.content).not.toContain("In allegato");
  });

  it("allega alla mail di attesa firme il PDF dello scarico del referente", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail();

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
      pdfBytes: new Uint8Array([37, 80, 68, 70]),
      filename: "scarico.pdf",
    });

    // Una mail sola al referente: l'avviso porta il PDF, cosi' la copia a se' stante non serve.
    expect(result).toEqual({ status: "SENT" });
    expect(waiverRecipients(calls)).toEqual(["mario@topfly.it"]);

    const payload = JSON.parse(calls[0].body!);
    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Prenotazione in attesa firme - gio 04 giu, 18:00",
    );
    expect(payload.message.body.content).toContain("In allegato trovi il PDF del tuo scarico");
    expect(payload.message.body.content).toContain("Link firma ospiti");
    expect(payload.message.attachments).toHaveLength(1);
    expect(payload.message.attachments[0].name).toBe("scarico.pdf");
    expect(payload.message.attachments[0].contentType).toBe("application/pdf");
    expect(payload.message.attachments[0].contentBytes).toBe("JVBERg==");
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
      signatureDeadlineAt: new Date("2026-06-04T14:00:00.000Z"),
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
    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Prenotazione modificata - gio 04 giu, 20:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Prenotazione modificata");
    expect(payload.message.body.content).toContain("18:00 - 19:00");
    expect(payload.message.body.content).toContain("Firma per il nuovo orario");
    expect(payload.message.body.content).toContain("/w/booking_guest/token123");
    const updatedContent = payload.message.body.content.replace(/\s+/g, " ");
    expect(updatedContent).toContain("16:00"); // scadenza firme 14:00 UTC resa in ora italiana
    expect(updatedContent).toContain(
      "Se manca anche una sola firma alla scadenza, la prenotazione viene annullata automaticamente.",
    );
  });

  it("usa un fallback quando la modifica ospite non ha una scadenza firme impostata", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendGuestBookingUpdatedEmail } = await import("@/lib/graph");
    const previousBooking = bookingFixture({ status: "CONFIRMED" });
    const booking = bookingFixture({
      ...previousBooking,
      start: new Date("2026-06-04T18:00:00.000Z"),
      end: new Date("2026-06-04T19:00:00.000Z"),
      waiverRevision: 2,
      signatureDeadlineAt: null,
    });

    await sendGuestBookingUpdatedEmail({
      previousBooking,
      booking,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
    });

    const mailCall = calls.find((call) => call.url.includes("/sendMail"));
    const content = JSON.parse(mailCall!.body!).message.body.content.replace(/\s+/g, " ");
    expect(content).toContain("la scadenza indicata nell'app");
    expect(content).toContain(
      "Se manca anche una sola firma alla scadenza, la prenotazione viene annullata automaticamente.",
    );
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
    expect(payload.message.subject).toBe("Padel TOPFLY - Prenotazione annullata - gio 04 giu, 18:00");
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(payload.message.body.content).toContain("Prenotazione annullata");
    expect(payload.message.attachments[0].name).toBe("padel-topfly-annullamento.ics");
    expect(payload.message.attachments[0].contentType).toBe("text/calendar; method=CANCEL");

    const ics = Buffer.from(payload.message.attachments[0].contentBytes, "base64").toString("utf8");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("UID:booking_guest-laura@example.com@padel.topflysolutions.com");
    // Qui la partita e' annullata per davvero: l'allegato puo' dirlo.
    expect(ics).toContain("DESCRIPTION:Prenotazione campo Padel TOPFLY annullata.");
    // Un allarme su un evento che sta sparendo non ha senso: la cancellazione non porta VALARM.
    expect(ics).not.toContain("BEGIN:VALARM");
    expect(ics).not.toContain("TRIGGER:-PT60M");
  });

  it("conferma la rinuncia a chi rinuncia e gli ritira l'evento firmato dal calendario", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendGuestWaiverConfirmationEmail, sendGuestWithdrawalConfirmationEmail } = await import(
      "@/lib/graph"
    );
    const booking = bookingFixture({ id: "booking_guest", status: "PENDING_SIGNATURES" });

    // Prima l'invito che l'ospite riceve firmando, poi la rinuncia: e' la sequenza reale.
    await sendGuestWaiverConfirmationEmail({
      booking: bookingFixture({ id: "booking_guest", status: "CONFIRMED" }),
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
      signedAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    const result = await sendGuestWithdrawalConfirmationEmail({
      booking,
      signerName: "Laura Bianchi",
      signerEmail: "laura@example.com",
    });

    const mailCalls = calls.filter((call) => call.url.includes("/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(mailCalls).toHaveLength(2);

    const invite = JSON.parse(mailCalls[0].body!);
    const payload = JSON.parse(mailCalls[1].body!);
    const content = payload.message.body.content.replace(/\s+/g, " ");

    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Rinuncia al posto confermata - gio 04 giu, 18:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("laura@example.com");
    expect(content).toContain("hai rinunciato al posto per la partita del gio 04 giu alle 18:00");
    expect(content).toContain("L'appuntamento viene rimosso dal tuo calendario.");

    const attachment = payload.message.attachments[0];
    expect(attachment.name).toBe("padel-topfly-annullamento.ics");
    expect(attachment.contentType).toBe("text/calendar; method=CANCEL");

    const ics = Buffer.from(attachment.contentBytes, "base64").toString("utf8");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");

    // La booking qui e' viva: l'ospite si e' sfilato, la partita torna in attesa firme. Il corpo
    // lo dice, e l'allegato dentro lo stesso messaggio non puo' dire il contrario. La SUMMARY
    // ("Accesso campo annullato") regge perche' parla dell'accesso del singolo; e' la DESCRIPTION
    // che parla della prenotazione.
    expect(ics).toContain("DESCRIPTION:Hai rinunciato al posto per questa partita di Padel TOPFLY.");
    expect(ics).not.toContain("Prenotazione campo Padel TOPFLY annullata.");

    // Senza UID identico a quello dell'invito mandato alla firma la cancellazione non aggancia
    // nulla e l'ospite si ritrova l'evento fantasma in agenda: e' il punto che regge tutto B3.
    const inviteIcs = Buffer.from(invite.message.attachments[0].contentBytes, "base64").toString(
      "utf8",
    );
    const uidOf = (value: string) => value.split("\r\n").find((line) => line.startsWith("UID:"));
    expect(uidOf(inviteIcs)).toBe("UID:booking_guest-laura@example.com@padel.topflysolutions.com");
    expect(uidOf(ics)).toBe(uidOf(inviteIcs));

    // L'invito alla firma suona un'ora prima (VALARM); la rinuncia che lo ritira no: l'evento
    // sparisce, un allarme lo seguirebbe nel nulla.
    expect(inviteIcs).toContain("BEGIN:VALARM");
    expect(inviteIcs).toContain("TRIGGER:-PT60M");
    expect(ics).not.toContain("BEGIN:VALARM");
    expect(ics).not.toContain("TRIGGER:-PT60M");
  });

  it("avvisa il referente quando un ospite rinuncia, dicendo chi e' stato ed entro quando", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(null, { status: 202 });
      }),
    );

    const { sendOrganizerGuestWithdrewEmail } = await import("@/lib/graph");
    const result = await sendOrganizerGuestWithdrewEmail({
      booking: bookingFixture({
        status: "PENDING_SIGNATURES",
        signatureDeadlineAt: new Date("2026-06-04T14:00:00.000Z"),
      }),
      signerName: "Luca Bianchi",
      signedCount: 3,
    });

    const mailCall = calls.find((call) => call.url.includes("/sendMail"));
    expect(result).toEqual({ status: "SENT" });
    expect(mailCall).toBeDefined();

    const payload = JSON.parse(mailCall!.body!);
    // L'HTML e' indentato su piu' righe: normalizzo gli spazi per asserire sulle frasi.
    const content = payload.message.body.content.replace(/\s+/g, " ");

    expect(payload.message.subject).toBe(
      "Padel TOPFLY - Luca Bianchi ha rinunciato al posto - gio 04 giu, 18:00",
    );
    expect(payload.message.toRecipients[0].emailAddress.address).toBe("mario@topfly.it");
    expect(content).toContain("Luca Bianchi ha rinunciato al posto");
    expect(content).toContain("3 di 4 raccolte, manca 1");
    expect(content).toContain("16:00"); // scadenza 14:00 UTC resa in ora italiana
    expect(content).toContain("viene annullata automaticamente");
    expect(content).toContain(
      'Usa il link firma ospiti che trovi nella mail "Padel TOPFLY - Prenotazione in attesa firme".',
    );
  });

  it("costruisce ogni email sullo stesso guscio, senza immagini e senza colori fuori dal brand", async () => {
    const messages = await renderAllMessages();
    expect(messages).toHaveLength(13);

    for (const mail of messages) {
      const content = mail.body.content;

      // Niente logo, niente icone remote, niente data-uri: le mail devono restare integre nei
      // client che bloccano le immagini.
      expect(content).not.toMatch(/<img/i);
      expect(content).not.toContain("data:image");
      // Il marchio si fa col colore e col testo.
      expect(content).toContain("TOPFLY GPS Solutions");
      // L'arancione non esiste nell'app: era off-brand e non deve tornare.
      expect(content).not.toContain("#b45309");
    }
  });

  // I controlli sotto girano tag per tag, non con un toContain sul corpo intero: "c'e' almeno un
  // bgcolor da qualche parte" passa anche se una cella colorata su tredici lo perde, e su Outlook
  // quella cella diventa proprio il testo chiaro su fondo bianco che il requisito vuole evitare.
  it("dichiara i vincoli Outlook su ogni tabella e su ogni cella, non una volta per mail", async () => {
    const messages = await renderAllMessages();

    for (const mail of messages) {
      const content = mail.body.content;
      const tables = content.match(/<table[^>]*>/g) ?? [];
      const cells = content.match(/<t[dh][^>]*>/g) ?? [];

      expect(tables.length).toBeGreaterThan(0);
      expect(cells.length).toBeGreaterThan(0);

      for (const table of tables) {
        // Tabelle di layout: i lettori di schermo non devono annunciarle come dati.
        expect(table).toContain('role="presentation"');
        expect(table).toContain('cellpadding="0" cellspacing="0" border="0"');
      }

      for (const cell of cells) {
        // Il motore Word non eredita il font: va ripetuto su ogni cella.
        expect(cell).toContain("font-family: Arial, Helvetica, sans-serif");
        // E ignora il background shorthand: senza bgcolor la cella colorata resta bianca.
        expect(cell).toContain("bgcolor=");
        if (/background:/.test(cell)) {
          const bgcolor = cell.match(/bgcolor="([^"]+)"/)?.[1];
          const background = cell.match(/background: ([^;]+);/)?.[1];
          expect(bgcolor).toBe(background);
        }
      }
    }
  });

  it("dichiara il font anche sui link, bottone e fallback in chiaro", async () => {
    const messages = await renderAllMessages();

    for (const mail of messages) {
      const links = mail.body.content.match(/<a [^>]*>/g) ?? [];

      for (const link of links) {
        // Sui link il motore Word applica il proprio stile Hyperlink: senza font esplicito il
        // fallback sotto il bottone - cioe' l'elemento che deve reggere dove il bottone non si
        // disegna - finisce nel serif di default, stonato rispetto al resto.
        expect(link).toContain("font-family: Arial, Helvetica, sans-serif");
      }
    }
  });

  it("regge i 560px anche dove max-width non esiste", async () => {
    const messages = await renderAllMessages();

    for (const mail of messages) {
      const content = mail.body.content;

      // Il motore Word ignora max-width ma legge width in CSS, e nella cascata la dichiarazione
      // CSS batte l'attributo di presentazione: un contenitore width="560" style="width: 100%"
      // su Outlook desktop resta al 100% e stira la mail per tutta la finestra. I 560px arrivano
      // dalla ghost table mso; attributo e style del contenitore fluido dicono la stessa cosa.
      expect(content).toContain('<!--[if mso]>');
      expect(content).toContain('width="560" style="width: 560px;');
      expect(content).toContain('width="100%" style="width: 100%; max-width: 560px;');
      expect(content).not.toContain('width="560" style="width: 100%');
    }
  });

  it("dice in ogni oggetto di quale partita si parla", async () => {
    const mails = await renderAllMails();

    for (const mail of mails) {
      expect(mail.subject.startsWith("Padel TOPFLY - ")).toBe(true);
      expect(mail.subject.endsWith("gio 04 giu, 18:00")).toBe(true);
    }
  });

  it("lascia la data fuori dal titolo dell'evento, che nell'agenda sta gia' sul suo giorno", async () => {
    const [withManageUrl, withoutManageUrl] = await renderOutlookEvents();

    // L'unica eccezione alla regola sopra, e detta invece che nascosta escludendo l'evento dal
    // corpus: non e' una mail ma il titolo di un appuntamento, che nella griglia dell'agenda si
    // porta gia' dietro giorno e ora. "- gio 04 giu, 18:00" in coda sarebbe rumore su ogni riga.
    for (const event of [withManageUrl, withoutManageUrl]) {
      expect(event.subject).toBe("Padel TOPFLY - Campo prenotato");
    }
  });

  it("apre ogni email col preheader, e ci mette il riassunto invece del nome dell'azienda", async () => {
    const mails = await renderAllMails();

    for (const mail of mails) {
      const content = mail.body.content;
      // Primo figlio: l'anteprima nella lista messaggi legge da li', quindi deve precedere la
      // fascia col marchio.
      expect(content.indexOf("mso-hide: all")).toBeLessThan(content.indexOf("TOPFLY GPS Solutions"));
      expect(preheaderOf(mail).length).toBeGreaterThan(0);
      expect(preheaderOf(mail)).not.toContain("TOPFLY GPS Solutions");
    }

    // Il sollecito e' la mail che arriva quando resta poco tempo: l'anteprima deve gia' dire
    // quante firme mancano ed entro quando, senza aprire.
    expect(preheaderOf(mailWithSubject(mails, "Mancano firme per confermare"))).toBe(
      "Mancano 3 firme: scadenza gio 04 giu, 14:00.",
    );
  });

  it("porta nella famiglia curata anche il sollecito e le mail nude", async () => {
    const mails = await renderAllMails();

    for (const fragment of [
      "Mancano firme per confermare",
      "ha rinunciato al posto",
      "Scarico di responsabilità",
    ]) {
      const content = mailWithSubject(mails, fragment).body.content;

      expect(content).not.toContain("<h2");
      expect(content).toContain("TOPFLY GPS Solutions");
      expect(content).toContain("#c81317");
    }
  });

  it("tiene il link in chiaro sotto ogni bottone", async () => {
    const mails = await renderAllMails();
    const content = mailWithSubject(mails, "Prenotazione in attesa firme").body.content;

    expect(content).toContain("Link firma ospiti");
    expect(content).toContain("Gestisci o annulla la prenotazione");
    // Due bottoni, due fallback testuali: dove il bottone non si disegna resta l'indirizzo.
    expect(content.match(/Link diretto:/g)).toHaveLength(2);
    expect(content).toContain("https://padel.topflysolutions.com/w/booking_1/token123");
    expect(content).toContain("https://padel.topflysolutions.com/manage/booking_1?token=manage");
  });

  it("distingue i due annullamenti e li tinge di danger, non di grigio", async () => {
    const mails = await renderAllMails();
    const auto = mailWithSubject(mails, "per firme mancanti");
    const byAdmin = mailWithSubject(mails, "dall'amministrazione");

    expect(auto.body.content).toContain("#b4232a");
    expect(byAdmin.body.content).toContain("#b4232a");
    // Due titoli identici non dicono al referente perche' la partita e' saltata.
    expect(auto.body.content).toContain("Annullata: firme mancanti");
    expect(byAdmin.body.content).toContain("Annullata dall'amministrazione");
  });

  it("non fa mai trapelare la causale d'annullamento in un'email", async () => {
    const messages = await renderAllMessages();
    const sentinel = "CAUSALE-SENTINELLA-Mario-Verdi";

    for (const mail of messages) {
      // La causale e' testo libero (puo' nascondere un nome): niente oggetto, corpo o allegato.
      expect(mail.subject).not.toContain(sentinel);
      expect(mail.body.content).not.toContain(sentinel);
      for (const attachment of mail.attachments ?? []) {
        expect(attachment.name).not.toContain(sentinel);
        if (typeof attachment.contentBytes === "string") {
          expect(Buffer.from(attachment.contentBytes, "base64").toString("utf8")).not.toContain(sentinel);
        }
      }
    }
  });

  it("chiama la prenotazione annullata, mai cancellata", async () => {
    const messages = await renderAllMessages();

    for (const mail of messages) {
      expect(mail.subject.toLowerCase()).not.toContain("cancellat");
      expect(mail.body.content.toLowerCase()).not.toContain("cancellat");

      // Anche il nome dell'allegato: si legge nella lista allegati, sotto un oggetto che dice
      // "annullata", ed era l'ultima occorrenza della parola bandita dentro un'email.
      for (const attachment of mail.attachments ?? []) {
        expect(attachment.name.toLowerCase()).not.toContain("cancellazion");
        expect(attachment.name.toLowerCase()).not.toContain("cancellat");
      }
    }
  });

  it("usa un solo nome per il documento e un solo formato di data", async () => {
    const mails = await renderAllMails();

    for (const mail of mails) {
      const content = mail.body.content.toLowerCase();

      // Un solo nome: chi cerca il documento in casella deve trovarlo.
      expect(content).not.toContain("modulo firmato");
      expect(content).not.toContain("liberatoria");
      expect(content).not.toContain("manleva");
      // "Firmato il: 15/07/26, 11:00" accanto a "Giorno: mer 15 lug" erano due formati di data
      // a un centimetro: adesso passano tutte dai formatter condivisi.
      expect(content).not.toMatch(/\d{2}\/\d{2}\/\d{2}/);
    }

    const confirmation = mailWithSubject(mails, "Firma accesso campo confermata");
    expect(confirmation.body.content).toContain("mer 03 giu, 12:00");
  });

  it("conta le firme una volta sola e senza leggersi al contrario", async () => {
    const mails = await renderAllMails();
    const pending = mailWithSubject(mails, "Prenotazione in attesa firme").body.content;

    // "Firme: 1/4 raccolte" nella tabella e "Mancano 3 firme" tre righe sotto dicevano lo stesso
    // fatto due volte; "mancano 3 su 4" per giunta si legge come "3 fatte su 4".
    expect(pending).toContain("1 di 4 raccolte, mancano 3");
    expect(pending).not.toContain("1/4");
    expect(pending).not.toContain("su 4 giocatori");
  });

  it("manda a cercare una mail che esiste davvero", async () => {
    const messages = await renderAllMessages();

    for (const mail of messages) {
      // Nessun oggetto si e' mai chiamato "prenotazione provvisoria": il rimando era un vicolo cieco.
      expect(mail.body.content.toLowerCase()).not.toContain("provvisoria");
      // E nessun messaggio rimanda a se stesso: cercare il link "nella mail X" mentre X e' la
      // mail che si sta leggendo, e il link non ce l'ha, e' lo stesso vicolo cieco chiuso in
      // cerchio. Se un rimando nomina una mail, non puo' nominare la propria.
      const referenced = mail.body.content.match(/nella mail "([^"]+)"/)?.[1];
      if (referenced) {
        expect(referenced).not.toBe(mail.subject);
      }
    }

    expect(mailWithSubject(messages, "Mancano firme per confermare").body.content).toContain(
      'Usa il link firma ospiti che trovi nella mail "Padel TOPFLY - Prenotazione in attesa firme".',
    );
  });

  it("non manda il referente a cercare il link dentro la mail che sta leggendo", async () => {
    const [withManageUrl, withoutManageUrl] = await renderOutlookEvents();

    expect(withManageUrl.body.content).toContain(
      "https://padel.topflysolutions.com/manage/booking_1?token=manage",
    );

    // signature-workflow chiama createOutlookEvent senza manageUrl (il token in chiaro non ce
    // l'ha), ed e' IL percorso di conferma: sia dall'ultima firma raccolta sia da playerCount 1.
    // Il ramo mandava a cercare il link nella mail "Padel TOPFLY - Campo prenotato", che e'
    // questa, e in cui il link non c'e' proprio perche' manageUrl manca.
    expect(withoutManageUrl.body.content).not.toContain("manage/booking_1");
    expect(withoutManageUrl.body.content).not.toContain('nella mail "Padel TOPFLY - Campo prenotato"');
    expect(withoutManageUrl.body.content).toContain(
      "apri la tua prenotazione nell'app Padel TOPFLY",
    );
  });

  it("non escapa l'oggetto della mail dello scarico: e' testo piano, non HTML", async () => {
    vi.resetModules();
    stubWaiverGraphEnv();

    const calls = stubWaiverSendMail();
    const { sendWaiverEmail } = await import("@/lib/graph");

    await sendWaiverEmail(waiverMailInput({ signerName: "Anna & Marco", legs: ["archive"] }));

    const message = JSON.parse(calls[0].body!).message;
    expect(message.subject).toBe(
      "Padel TOPFLY - Scarico di responsabilità - Anna & Marco - gio 04 giu, 18:00",
    );
    // Nel corpo invece l'escape ci vuole davvero: li' e' HTML.
    expect(message.body.content).toContain("Anna &amp; Marco");
  });

  it("costruisce anche il corpo dell'evento Outlook sullo stesso guscio", async () => {
    vi.resetModules();
    vi.stubEnv("MS_GRAPH_TENANT_ID", "tenant");
    vi.stubEnv("MS_GRAPH_CLIENT_ID", "client");
    vi.stubEnv("MS_GRAPH_CLIENT_SECRET", "secret");
    vi.stubEnv("MS_GRAPH_MAILBOX", "padel@topfly.it");

    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, body: init?.body?.toString() });

        if (url.includes("login.microsoftonline.com")) {
          return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
            status: 200,
          });
        }

        return new Response(JSON.stringify({ id: "event_1" }), { status: 201 });
      }),
    );

    const { createOutlookEvent } = await import("@/lib/graph");
    const booking = bookingFixture();

    await createOutlookEvent(
      booking,
      { email: booking.organizerEmail, name: booking.organizerName },
      "https://padel.topflysolutions.com/manage/booking_1?token=abc",
    );

    const payload = JSON.parse(calls.find((call) => call.url.includes("/calendar/events"))!.body!);
    const content = payload.body.content;

    expect(content).not.toMatch(/<img/i);
    expect(content).toContain('role="presentation"');
    expect(content).toContain("bgcolor=");
    // Tutte le mail restano sulla gamma del brand: nessun tono verde.
    expect(content).toContain("#c81317");
    expect(content).not.toContain("#0f7a4f");
    expect(content).toContain("Prenotazione campo confermata");
    expect(content).toContain("Link diretto:");
    // L'invito nasce a firme complete: nessuno da mandare a firmare.
    expect(content).not.toContain("Link firma ospiti");
    // Nessun percorso puo' passare qui una prenotazione annullata (le cancellazioni usano il POST
    // cancel dell'evento): l'evento nasce sempre occupato e con promemoria.
    expect(payload.showAs).toBe("busy");
    expect(payload.isReminderOn).toBe(true);
  });
});
