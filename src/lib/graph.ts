import type { Booking } from "@prisma/client";
import { appConfig, hasGraphConfig } from "@/lib/config";

type GraphSyncResult =
  | { status: "SKIPPED"; eventId?: string; error?: string }
  | { status: "SYNCED"; eventId?: string; error?: string }
  | { status: "FAILED"; eventId?: string; error: string };

type WaiverMailResult =
  | { status: "SKIPPED"; error?: string }
  | { status: "SENT" }
  | { status: "FAILED"; error: string };

type GraphToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: GraphToken | null = null;

function graphDisabled(): GraphSyncResult | null {
  if (!hasGraphConfig()) {
    return {
      status: "SKIPPED",
      error: "Microsoft Graph non configurato.",
    };
  }

  return null;
}

async function getGraphToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    client_id: appConfig.graph.clientId!,
    client_secret: appConfig.graph.clientSecret!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(
    `https://login.microsoftonline.com/${appConfig.graph.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!response.ok) {
    throw new Error(`Graph token error ${response.status}`);
  }

  const json = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

async function graphFetch(path: string, init: RequestInit = {}) {
  const token = await getGraphToken();
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(graphErrorMessage(response, body));
  }

  return response;
}

function graphErrorMessage(response: Response, body: string) {
  let code = "";

  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    code = parsed.error?.code ? ` (${parsed.error.code})` : "";
  } catch {
    code = "";
  }

  return `Graph ${response.status}${code}`;
}

type OrganizerContact = {
  email: string;
  name: string;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatEventDate(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function formatEventTime(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: appConfig.timeZone,
  }).format(date);
}

function formatDuration(start: Date, end: Date) {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function eventPayload(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
  guestWaiverUrl?: string,
) {
  const isCanceled = booking.status === "CANCELED";
  const organizerName = escapeHtml(organizer.name);
  const safeManageUrl = manageUrl ? escapeHtml(manageUrl) : null;
  const safeGuestWaiverUrl = guestWaiverUrl ? escapeHtml(guestWaiverUrl) : null;
  const dateLabel = escapeHtml(formatEventDate(booking.start));
  const startLabel = escapeHtml(formatEventTime(booking.start));
  const endLabel = escapeHtml(formatEventTime(booking.end));
  const durationLabel = escapeHtml(`${formatDuration(booking.start, booking.end)} min`);
  const actionCopy =
    !isCanceled && safeManageUrl
    ? `
      <p style="margin: 22px 0 10px;">
        <a href="${safeManageUrl}" style="display: inline-block; background: #f80d17; color: #ffffff; text-decoration: none; font-weight: 700; padding: 13px 18px; border-radius: 8px;">
          Gestisci prenotazione
        </a>
      </p>
      <p style="margin: 0; color: #6b7280; font-size: 13px;">
        Link diretto: <a href="${safeManageUrl}" style="color: #b91c1c;">${safeManageUrl}</a>
      </p>
      ${
        safeGuestWaiverUrl
          ? `
      <p style="margin: 18px 0 8px; font-weight: 700;">
        Fai firmare anche gli altri giocatori:
      </p>
      <p style="margin: 0 0 8px;">
        <a href="${safeGuestWaiverUrl}" style="display: inline-block; background: #24262d; color: #ffffff; text-decoration: none; font-weight: 700; padding: 12px 16px; border-radius: 8px;">
          Link firma ospiti
        </a>
      </p>
      <p style="margin: 0; color: #6b7280; font-size: 13px;">
        Link ospiti: <a href="${safeGuestWaiverUrl}" style="color: #374151;">${safeGuestWaiverUrl}</a>
      </p>
          `
          : ""
      }
    `
    : !isCanceled
      ? `
      <p style="margin: 18px 0 0; color: #6b7280;">
        Per modifiche o cancellazioni, usa il link ricevuto nella conferma originale.
      </p>
    `
      : "";
  const headerColor = isCanceled ? "#4b5563" : "#f80d17";
  const heading = isCanceled
    ? "Prenotazione campo cancellata"
    : "Prenotazione campo confermata";
  const intro = isCanceled
    ? `la tua prenotazione del campo da padel aziendale &egrave; stata cancellata.`
    : `la tua prenotazione del campo da padel aziendale &egrave; confermata.`;
  const statusCopy = isCanceled
    ? "Il campo torna disponibile per gli altri colleghi."
    : "Ti arriver&agrave; un promemoria Outlook 1 ora prima.";
  const footerCopy = isCanceled
    ? "Non devi fare altro: questa fascia non risulta pi&ugrave; prenotata a tuo nome."
    : "Se cambi programma, modifica o cancella la prenotazione: cos&igrave; lasci libero il campo per gli altri.";

  return {
    subject: isCanceled ? "Padel TOPFLY - Prenotazione cancellata" : "Padel TOPFLY - Campo prenotato",
    body: {
      contentType: "HTML",
      content: `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #24262d; line-height: 1.45; max-width: 560px;">
          <div style="background: ${headerColor}; color: #ffffff; padding: 18px 20px; border-radius: 10px 10px 0 0;">
            <div style="font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;">
              TOPFLY GPS Solutions
            </div>
            <div style="font-size: 22px; font-weight: 700; margin-top: 6px;">
              ${heading}
            </div>
          </div>

          <div style="border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 10px 10px; padding: 20px; background: #ffffff;">
            <p style="margin: 0 0 16px; font-size: 16px;">
              Ciao ${organizerName},<br>
              ${intro}
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; background: #f8fafc; border-radius: 8px; overflow: hidden;">
              <tr>
                <td style="padding: 14px 16px; color: #6b7280; font-size: 13px; width: 36%;">Giorno</td>
                <td style="padding: 14px 16px; font-weight: 700;">${dateLabel}</td>
              </tr>
              <tr>
                <td style="padding: 0 16px 14px; color: #6b7280; font-size: 13px;">Orario</td>
                <td style="padding: 0 16px 14px; font-weight: 700;">${startLabel} - ${endLabel}</td>
              </tr>
              <tr>
                <td style="padding: 0 16px 14px; color: #6b7280; font-size: 13px;">Durata</td>
                <td style="padding: 0 16px 14px; font-weight: 700;">${durationLabel}</td>
              </tr>
            </table>

            <p style="margin: 16px 0 0; color: #4b5563;">
              ${statusCopy}
            </p>

            ${actionCopy}

            <p style="margin: 18px 0 0; color: #6b7280; font-size: 13px;">
              ${footerCopy}
            </p>
          </div>
        </div>
      `,
    },
    start: {
      dateTime: booking.start.toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: booking.end.toISOString(),
      timeZone: "UTC",
    },
    attendees: [
      {
        emailAddress: {
          address: organizer.email,
          name: organizer.name,
        },
        type: "required",
      },
    ],
    isReminderOn: !isCanceled,
    reminderMinutesBeforeStart: 60,
    showAs: isCanceled ? "free" : "busy",
  };
}

function waiverMailPayload(input: {
  recipientEmail: string;
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  pdfBytes: Uint8Array;
  filename: string;
}) {
  const dateLabel = escapeHtml(formatEventDate(input.booking.start));
  const startLabel = escapeHtml(formatEventTime(input.booking.start));
  const endLabel = escapeHtml(formatEventTime(input.booking.end));
  const signerName = escapeHtml(input.signerName);
  const signerEmail = escapeHtml(input.signerEmail);
  const signedAt = escapeHtml(
    new Intl.DateTimeFormat("it-IT", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: appConfig.timeZone,
    }).format(input.signedAt),
  );

  return {
    message: {
      subject: `Padel TOPFLY - Scarico responsabilita' ${signerName}`,
      body: {
        contentType: "HTML",
        content: `
          <div style="font-family: Arial, Helvetica, sans-serif; color: #24262d; line-height: 1.45; max-width: 560px;">
            <h2 style="margin: 0 0 12px;">Scarico responsabilita' Padel TOPFLY</h2>
            <p style="margin: 0 0 12px;">
              In allegato il modulo firmato digitalmente per l'accesso al campo.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 6px 0; color: #6b7280; width: 34%;">Firmatario</td>
                <td style="padding: 6px 0; font-weight: 700;">${signerName}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #6b7280;">Email</td>
                <td style="padding: 6px 0;">${signerEmail}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #6b7280;">Prenotazione</td>
                <td style="padding: 6px 0;">${dateLabel} · ${startLabel} - ${endLabel}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #6b7280;">Firmato il</td>
                <td style="padding: 6px 0;">${signedAt}</td>
              </tr>
            </table>
          </div>
        `,
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.recipientEmail,
          },
        },
      ],
      attachments: [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: input.filename,
          contentType: "application/pdf",
          contentBytes: Buffer.from(input.pdfBytes).toString("base64"),
        },
      ],
    },
    saveToSentItems: true,
  };
}

function icsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function icsDate(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function guestCalendarAttachment(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  cancelUrl?: string;
}) {
  const description = [
    "Firma scarico responsabilita' registrata.",
    input.cancelUrl ? `Se non puoi partecipare, rinuncia al posto qui: ${input.cancelUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TOPFLY//Padel TOPFLY//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(`${input.booking.id}-${input.signerEmail}`)}@padel.topflysolutions.com`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(input.booking.start)}`,
    `DTEND:${icsDate(input.booking.end)}`,
    `SUMMARY:${icsText("Padel TOPFLY - Accesso campo")}`,
    `DESCRIPTION:${icsText(description)}`,
    "LOCATION:Campo Padel TOPFLY",
    `ATTENDEE;CN=${icsText(input.signerName)}:mailto:${input.signerEmail}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "padel-topfly.ics",
    contentType: "text/calendar",
    contentBytes: Buffer.from(ics).toString("base64"),
  };
}

function guestWaiverConfirmationPayload(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  cancelUrl?: string;
}) {
  const dateLabel = escapeHtml(formatEventDate(input.booking.start));
  const startLabel = escapeHtml(formatEventTime(input.booking.start));
  const endLabel = escapeHtml(formatEventTime(input.booking.end));
  const signerName = escapeHtml(input.signerName);
  const safeCancelUrl = input.cancelUrl ? escapeHtml(input.cancelUrl) : null;
  const signedAt = escapeHtml(
    new Intl.DateTimeFormat("it-IT", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: appConfig.timeZone,
    }).format(input.signedAt),
  );

  return {
    message: {
      subject: "Padel TOPFLY - Firma accesso campo confermata",
      body: {
        contentType: "HTML",
        content: `
          <div style="font-family: Arial, Helvetica, sans-serif; color: #24262d; line-height: 1.45; max-width: 560px;">
            <div style="background: #f80d17; color: #ffffff; padding: 18px 20px; border-radius: 10px 10px 0 0;">
              <div style="font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;">TOPFLY GPS Solutions</div>
              <div style="font-size: 22px; font-weight: 700; margin-top: 6px;">Firma accesso campo confermata</div>
            </div>
            <div style="border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 10px 10px; padding: 20px; background: #ffffff;">
              <p style="margin: 0 0 16px; font-size: 16px;">
                Ciao ${signerName},<br>
                la tua firma per l'accesso al campo Padel TOPFLY e' stata registrata.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; background: #f8fafc; border-radius: 8px; overflow: hidden;">
                <tr>
                  <td style="padding: 14px 16px; color: #6b7280; font-size: 13px; width: 36%;">Giorno</td>
                  <td style="padding: 14px 16px; font-weight: 700;">${dateLabel}</td>
                </tr>
                <tr>
                  <td style="padding: 0 16px 14px; color: #6b7280; font-size: 13px;">Orario</td>
                  <td style="padding: 0 16px 14px; font-weight: 700;">${startLabel} - ${endLabel}</td>
                </tr>
                <tr>
                  <td style="padding: 0 16px 14px; color: #6b7280; font-size: 13px;">Firmato il</td>
                  <td style="padding: 0 16px 14px;">${signedAt}</td>
                </tr>
              </table>
              <p style="margin: 16px 0 0; color: #4b5563;">
                In allegato trovi un file calendario per salvare l'evento.
              </p>
              ${
                safeCancelUrl
                  ? `
              <p style="margin: 22px 0 10px;">
                <a href="${safeCancelUrl}" style="display: inline-block; background: #24262d; color: #ffffff; text-decoration: none; font-weight: 700; padding: 13px 18px; border-radius: 8px;">
                  Rinuncia al posto
                </a>
              </p>
              <p style="margin: 0; color: #6b7280; font-size: 13px;">
                Se non puoi essere presente, usa questo link: <a href="${safeCancelUrl}" style="color: #374151;">${safeCancelUrl}</a>
              </p>
                  `
                  : ""
              }
            </div>
          </div>
        `,
      },
      toRecipients: [
        {
          emailAddress: {
            address: input.signerEmail,
            name: input.signerName,
          },
        },
      ],
      attachments: [guestCalendarAttachment(input)],
    },
    saveToSentItems: true,
  };
}

function cancelComment(organizer: OrganizerContact) {
  return [
    `Ciao ${organizer.name},`,
    "",
    "la tua prenotazione del campo Padel TOPFLY e' stata cancellata.",
    "Il campo torna disponibile per gli altri colleghi.",
  ].join("\n");
}

function mailboxPath(path: string) {
  return `/users/${encodeURIComponent(appConfig.graph.mailbox!)}${path}`;
}

export async function createOutlookEvent(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
  guestWaiverUrl?: string,
): Promise<GraphSyncResult> {
  const disabled = graphDisabled();
  if (disabled) return disabled;

  try {
    const response = await graphFetch(mailboxPath("/calendar/events"), {
      method: "POST",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl, guestWaiverUrl)),
    });
    const json = (await response.json()) as { id?: string };

    return { status: "SYNCED", eventId: json.id };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph create failed",
    };
  }
}

export async function updateOutlookEvent(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
  guestWaiverUrl?: string,
): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return createOutlookEvent(booking, organizer, manageUrl, guestWaiverUrl);
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}`), {
      method: "PATCH",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl, guestWaiverUrl)),
    });

    return { status: "SYNCED", eventId: booking.outlookEventId };
  } catch (error) {
    return {
      status: "FAILED",
      eventId: booking.outlookEventId,
      error: error instanceof Error ? error.message : "Graph update failed",
    };
  }
}

export async function sendWaiverEmail(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  pdfBytes: Uint8Array;
  filename: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(
        waiverMailPayload({
          ...input,
          recipientEmail: appConfig.waiver.recipientEmail,
        }),
      ),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function sendGuestWaiverConfirmationEmail(input: {
  booking: Booking;
  signerName: string;
  signerEmail: string;
  signedAt: Date;
  cancelUrl?: string;
}): Promise<WaiverMailResult> {
  const disabled = graphDisabled();
  if (disabled) {
    return { status: "SKIPPED", error: disabled.error };
  }

  try {
    await graphFetch(mailboxPath("/sendMail"), {
      method: "POST",
      body: JSON.stringify(guestWaiverConfirmationPayload(input)),
    });

    return { status: "SENT" };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message : "Graph sendMail failed",
    };
  }
}

export async function deleteOutlookEvent(booking: Booking): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return { status: "SKIPPED", error: "Nessun evento Outlook collegato." };
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    const organizer = { email: booking.organizerEmail, name: booking.organizerName };
    const warnings: string[] = [];

    try {
      await graphFetch(mailboxPath(`/events/${booking.outlookEventId}`), {
        method: "PATCH",
        body: JSON.stringify(eventPayload(booking, organizer)),
      });
    } catch (error) {
      warnings.push(
        `Evento cancellazione non aggiornato: ${
          error instanceof Error ? error.message : "Graph update before cancel failed"
        }`,
      );
    }

    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}/cancel`), {
      method: "POST",
      body: JSON.stringify({ comment: cancelComment(organizer) }),
    });

    if (warnings.length > 0) {
      return {
        status: "SYNCED",
        eventId: booking.outlookEventId,
        error: warnings.join(" | "),
      };
    }

    return { status: "SYNCED", eventId: booking.outlookEventId };
  } catch (error) {
    return {
      status: "FAILED",
      eventId: booking.outlookEventId,
      error: error instanceof Error ? error.message : "Graph delete failed",
    };
  }
}
