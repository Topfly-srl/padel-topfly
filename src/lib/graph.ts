import type { Booking } from "@prisma/client";
import { appConfig, hasGraphConfig } from "@/lib/config";

type GraphSyncResult =
  | { status: "SKIPPED"; eventId?: string; error?: string }
  | { status: "SYNCED"; eventId?: string; error?: string }
  | { status: "FAILED"; eventId?: string; error: string };

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
    throw new Error(`Graph ${response.status}: ${body.slice(0, 500)}`);
  }

  return response;
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

function eventPayload(booking: Booking, organizer: OrganizerContact, manageUrl?: string) {
  const organizerName = escapeHtml(organizer.name);
  const safeManageUrl = manageUrl ? escapeHtml(manageUrl) : null;
  const dateLabel = escapeHtml(formatEventDate(booking.start));
  const startLabel = escapeHtml(formatEventTime(booking.start));
  const endLabel = escapeHtml(formatEventTime(booking.end));
  const durationLabel = escapeHtml(`${formatDuration(booking.start, booking.end)} min`);
  const manageCopy = safeManageUrl
    ? `
      <p style="margin: 22px 0 10px;">
        <a href="${safeManageUrl}" style="display: inline-block; background: #f80d17; color: #ffffff; text-decoration: none; font-weight: 700; padding: 13px 18px; border-radius: 8px;">
          Gestisci prenotazione
        </a>
      </p>
      <p style="margin: 0; color: #6b7280; font-size: 13px;">
        Link diretto: <a href="${safeManageUrl}" style="color: #b91c1c;">${safeManageUrl}</a>
      </p>
    `
    : `
      <p style="margin: 18px 0 0; color: #6b7280;">
        Per modifiche o cancellazioni, usa il link ricevuto nella conferma originale.
      </p>
    `;

  return {
    subject: "Padel TOPFLY - Campo prenotato",
    body: {
      contentType: "HTML",
      content: `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #24262d; line-height: 1.45; max-width: 560px;">
          <div style="background: #f80d17; color: #ffffff; padding: 18px 20px; border-radius: 10px 10px 0 0;">
            <div style="font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;">
              TOPFLY GPS Solutions
            </div>
            <div style="font-size: 22px; font-weight: 700; margin-top: 6px;">
              Prenotazione campo confermata
            </div>
          </div>

          <div style="border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 10px 10px; padding: 20px; background: #ffffff;">
            <p style="margin: 0 0 16px; font-size: 16px;">
              Ciao ${organizerName},<br>
              la tua prenotazione del campo da padel aziendale &egrave; confermata.
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
              Ti arriver&agrave; un promemoria Outlook 1 ora prima.
            </p>

            ${manageCopy}

            <p style="margin: 18px 0 0; color: #6b7280; font-size: 13px;">
              Se cambi programma, modifica o cancella la prenotazione: cos&igrave; lasci libero il campo per gli altri.
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
    isReminderOn: true,
    reminderMinutesBeforeStart: 60,
    showAs: "busy",
  };
}

function mailboxPath(path: string) {
  return `/users/${encodeURIComponent(appConfig.graph.mailbox!)}${path}`;
}

export async function createOutlookEvent(
  booking: Booking,
  organizer: OrganizerContact,
  manageUrl?: string,
): Promise<GraphSyncResult> {
  const disabled = graphDisabled();
  if (disabled) return disabled;

  try {
    const response = await graphFetch(mailboxPath("/calendar/events"), {
      method: "POST",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl)),
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
): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return createOutlookEvent(booking, organizer, manageUrl);
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}`), {
      method: "PATCH",
      body: JSON.stringify(eventPayload(booking, organizer, manageUrl)),
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

export async function deleteOutlookEvent(booking: Booking): Promise<GraphSyncResult> {
  if (!booking.outlookEventId) {
    return { status: "SKIPPED", error: "Nessun evento Outlook collegato." };
  }

  const disabled = graphDisabled();
  if (disabled) return { ...disabled, eventId: booking.outlookEventId };

  try {
    await graphFetch(mailboxPath(`/events/${booking.outlookEventId}`), {
      method: "DELETE",
    });

    return { status: "SYNCED", eventId: booking.outlookEventId };
  } catch (error) {
    return {
      status: "FAILED",
      eventId: booking.outlookEventId,
      error: error instanceof Error ? error.message : "Graph delete failed",
    };
  }
}
