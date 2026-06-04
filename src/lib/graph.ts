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

function eventPayload(booking: Booking, organizer: OrganizerContact, manageUrl?: string) {
  const organizerName = escapeHtml(organizer.name);
  const safeManageUrl = manageUrl ? escapeHtml(manageUrl) : null;
  const manageCopy = manageUrl
    ? `<p>Puoi modificare o cancellare la prenotazione da qui: <a href="${safeManageUrl}">${safeManageUrl}</a></p>`
    : "<p>Per modifiche o cancellazioni, usa il link ricevuto nella conferma originale.</p>";

  return {
    subject: "Padel TOPFLY - Prenotazione campo",
    body: {
      contentType: "HTML",
      content: `<p>${organizerName} ha prenotato il campo da padel aziendale.</p>${manageCopy}`,
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
